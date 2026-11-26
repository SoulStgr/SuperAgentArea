/**
 * The WeChat iLink transport and its QR sign-in sessions, without WeChat: the wire payloads, headers and status mapping over
 * a fake fetch, inbound normalization, text splitting, and the login manager's background poll writing one credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginWeixinLogin, clearWeixinLiveCredentials, getWeixinUpdates, liveWeixinCredential, normalizeWeixinInbound,
  pollWeixinLogin, rejectedProviderResponse, registerWeixinCredential, sendWeixinReply, sendWeixinText, splitWeixinText,
  trustedWeixinUrl, unregisterWeixinCredential, WEIXIN_PROTOCOL_VERSION, WEIXIN_REPLY_CHARS, WEIXIN_TEXT_CHARS,
  weixinClientId, weixinReplyTargetOf, WeixinApiError,
} from '../src/sources/im/weixin-transport.ts'
import { renderWeixinQrImage, WeixinLoginManager, weixinToken, type WeixinCredential } from '../src/sources/im/weixin-login.ts'

interface FakeCall { url: string; method: string; headers: Record<string, string>; body: unknown }
type Answer = { status?: number; body: unknown } | Error
/** A fake fetch that records each call and answers from a callback; a thrown Error is a socket-level failure. */
function fakeFetch(answer: (call: FakeCall) => Answer | Promise<Answer>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = { url: String(input), method: init?.method ?? 'GET',
      headers: { ...(init?.headers ?? {}) as Record<string, string> },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined }
    calls.push(call)
    const result = await answer(call)
    if (result instanceof Error) throw result
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200,
      headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}
/** A fake fetch that never answers until its request is aborted, as iLink's long poll does when nothing new arrived. */
const hangingFetch = (): typeof fetch => ((_url: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  const fail = (): void => reject(new DOMException('The operation was aborted', 'AbortError'))
  if (signal?.aborted) { fail(); return }
  signal?.addEventListener('abort', fail, { once: true })
})) as typeof fetch
const credential = (overrides: Partial<WeixinCredential> = {}): WeixinCredential =>
  ({ token: 'bot-token-1', ilinkBotId: 'bot-1', at: '2026-11-26T00:00:00.000Z', ...overrides })

beforeEach(() => { clearWeixinLiveCredentials() })

describe('the QR sign-in handshake', () => {
  it('asks for a bot QR code of the configured type and returns its token and image content', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { qrcode: 'qr-token', qrcode_img_content: 'https://weixin.qq.com/qr.png' } }))
    expect(await beginWeixinLogin({ fetchImpl })).toEqual({ qrcode: 'qr-token', qrContent: 'https://weixin.qq.com/qr.png' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', body: { local_token_list: [] },
      headers: expect.objectContaining({ 'iLink-App-Id': 'bot' }) })
    expect(calls[0]!.url).toContain('ilink/bot/get_bot_qrcode?bot_type=3')
    // A rejected request and an answer without a token are classified errors, not empty results.
    await expect(beginWeixinLogin({ fetchImpl: fakeFetch(() => ({ body: { ret: -1 } })).fetchImpl }))
      .rejects.toMatchObject({ code: 'rejected', providerCode: '-1' })
    await expect(beginWeixinLogin({ fetchImpl: fakeFetch(() => ({ body: {} })).fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('maps each status answer and carries the confirmed credentials without exposing them elsewhere', async () => {
    const status = (body: Record<string, unknown>) => fakeFetch(() => ({ body })).fetchImpl
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'wait' }) })).toEqual({ status: 'wait' })
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'scaned' }) })).toEqual({ status: 'scaned' })
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'scaned_but_redirect', redirect_host: 'x' }) }))
      .toEqual({ status: 'scaned' })
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'expired' }) })).toEqual({ status: 'expired' })
    const confirmed = await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'confirmed', bot_token: 'tok',
      ilink_bot_id: 'bot-1', ilink_user_id: 'user-1', baseurl: 'https://ilinkai.weixin.qq.com/' }) })
    expect(confirmed).toMatchObject({ status: 'confirmed', botToken: 'tok', ilinkBotId: 'bot-1', ilinkUserId: 'user-1' })
    // An incomplete confirmation, an unrecognized state and a state that needs a verification code all fail the attempt.
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'confirmed' }) }))
      .toMatchObject({ status: 'failed' })
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'need_verifycode' }) }))
      .toMatchObject({ status: 'failed' })
    expect(await pollWeixinLogin({ qrcode: 'qr', fetchImpl: status({ status: 'nonsense' }) })).toMatchObject({ status: 'failed' })
    await expect(pollWeixinLogin({ qrcode: '', fetchImpl: status({ status: 'wait' }) })).rejects.toThrow(TypeError)
  })
})

describe('the message loop and replies', () => {
  it('polls with the bot token and cursor, returns the new cursor, and reads a stale token as auth', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { ret: 0, get_updates_buf: 'cursor-2',
      msgs: [{ message_id: 'm1', from_user_id: 'user-1' }] } }))
    expect(await getWeixinUpdates({ token: 'bot-token-1', cursor: 'cursor-1', fetchImpl })).toEqual({ msgs: [
      { message_id: 'm1', from_user_id: 'user-1' }], cursor: 'cursor-2' })
    expect(calls[0]).toMatchObject({ method: 'POST', headers: expect.objectContaining({
      Authorization: 'Bearer bot-token-1', AuthorizationType: 'ilink_bot_token' }),
      body: { get_updates_buf: 'cursor-1', base_info: { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'dsh-superagent' } } })
    expect(calls[0]!.url).toContain('ilink/bot/getupdates')
    // A long-poll timeout means "no messages yet", not a failed poll; iLink's own -14 means the token must be renewed.
    expect(await getWeixinUpdates({ token: 't', cursor: 'c', fetchImpl: hangingFetch(), timeoutMs: 10 }))
      .toEqual({ msgs: [], cursor: 'c' })
    await expect(getWeixinUpdates({ token: 'stale', fetchImpl: fakeFetch(() => ({ body: { ret: -14 } })).fetchImpl }))
      .rejects.toMatchObject({ code: 'auth', providerCode: '-14' })
    await expect(getWeixinUpdates({ token: 't', fetchImpl: fakeFetch(() => ({ body: { ret: 1 } })).fetchImpl }))
      .rejects.toMatchObject({ code: 'rejected' })
    await expect(getWeixinUpdates({ token: '' })).rejects.toThrow(TypeError)
  })
  it('sends a reply text item with the recipient, the conversation token and the message id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { ret: 0 } }))
    const sent = await sendWeixinText({ token: 'bot-token-1', toUserId: 'user-1', text: 'Done.',
      contextToken: 'ctx-1', runId: 'msg-1', clientId: 'client-1', fetchImpl })
    expect(sent).toEqual({ clientId: 'client-1' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: {
      msg: { from_user_id: '', to_user_id: 'user-1', client_id: 'client-1', message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'Done.' } }], context_token: 'ctx-1', run_id: 'msg-1' },
      base_info: { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'dsh-superagent' } } })
    expect(calls[0]!.url).toContain('ilink/bot/sendmessage')
    await expect(sendWeixinText({ token: 'stale', toUserId: 'user-1', text: 'x',
      fetchImpl: fakeFetch(() => ({ body: { ret: -14 } })).fetchImpl })).rejects.toMatchObject({ code: 'auth' })
    await expect(sendWeixinText({ token: 't', toUserId: 'user-1', text: 'x',
      fetchImpl: fakeFetch(() => ({ body: { ret: 7 } })).fetchImpl })).rejects.toMatchObject({ code: 'rejected' })
    await expect(sendWeixinText({ token: 't', toUserId: 'user-1', text: 'x',
      fetchImpl: fakeFetch(() => ({ status: 500, body: {} })).fetchImpl })).rejects.toMatchObject({ code: 'network' })
    await expect(sendWeixinText({ token: '', toUserId: 'user-1', text: 'x' })).rejects.toThrow(TypeError)
  })
  it('splits a long reply at 1,800 characters, reuses a stable client id and reads a reply route', async () => {
    expect(splitWeixinText('one line')).toEqual(['one line'])
    expect(splitWeixinText('   ')).toEqual([])
    const long = `${'a'.repeat(WEIXIN_REPLY_CHARS)}\n${'b'.repeat(WEIXIN_REPLY_CHARS)}`
    expect(splitWeixinText(long)).toEqual(['a'.repeat(WEIXIN_REPLY_CHARS), 'b'.repeat(WEIXIN_REPLY_CHARS)])
    expect(splitWeixinText(long)[0]).toHaveLength(WEIXIN_REPLY_CHARS)
    expect(weixinClientId('m-1', 0)).toBe(weixinClientId('m-1', 0))
    expect(weixinClientId('m-1', 0)).not.toBe(weixinClientId('m-2', 0))
    expect(weixinClientId('m-1', 0)).toMatch(/^dsh-weixin-[0-9a-f]{32}$/)
    // A whole reply goes out as one Channel message per split piece, in order.
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { ret: 0 } }))
    const result = await sendWeixinReply({ id: 'm-1', kind: 'reply', text: long,
      channel: { source: 'wechat:ops', thread: 'wechat:ops:user-1', address: {} } },
    { token: 'tok', target: { toUserId: 'user-1', messageId: 'msg-1', contextToken: 'ctx-1' }, fetchImpl })
    expect(result).toBe('sent')
    expect(calls).toHaveLength(2)
    expect(calls.map(call => (call.body as { msg: { item_list: { text_item: { text: string } }[] } }).msg.item_list[0]!.text_item.text))
      .toEqual(['a'.repeat(WEIXIN_REPLY_CHARS), 'b'.repeat(WEIXIN_REPLY_CHARS)])
    expect(weixinReplyTargetOf({ fromUserId: 'user-1', messageId: 'msg-1', contextToken: 'ctx-1' }))
      .toEqual({ toUserId: 'user-1', messageId: 'msg-1', contextToken: 'ctx-1' })
    expect(weixinReplyTargetOf({ messageId: 'msg-1' })).toBeUndefined()
  })
  it('keeps a trusted WeChat URL and asks for a data URL otherwise, and tracks one live credential per instance', async () => {
    expect(trustedWeixinUrl('https://weixin.qq.com/qr.png')).toBe('https://weixin.qq.com/qr.png')
    expect(trustedWeixinUrl('http://weixin.qq.com/qr.png')).toBe('')
    expect(trustedWeixinUrl('https://evil.example/qr.png')).toBe('')
    expect(trustedWeixinUrl('javascript:alert(1)')).toBe('')
    const rendered = await renderWeixinQrImage('weixin://scan?x=1')
    expect(rendered.startsWith('data:image/png;base64,')).toBe(true)
    registerWeixinCredential('wechat:ops', 'tok-1')
    expect(liveWeixinCredential('wechat:ops')).toBe('tok-1')
    registerWeixinCredential('wechat:ops', 'tok-2')
    expect(liveWeixinCredential('wechat:ops')).toBe('tok-2')
    unregisterWeixinCredential('wechat:ops', 'tok-1')
    expect(liveWeixinCredential('wechat:ops')).toBe('tok-2')
    unregisterWeixinCredential('wechat:ops', 'tok-2')
    expect(liveWeixinCredential('wechat:ops')).toBeUndefined()
  })
  it('classifies provider codes and a rejected answer without a JSON body', () => {
    expect(rejectedProviderResponse({ ret: 0 })).toBeUndefined()
    expect(rejectedProviderResponse({ errcode: '0' })).toBeUndefined()
    expect(rejectedProviderResponse({ ret: -14 })).toBe('-14')
    expect(rejectedProviderResponse({ errcode: 'nonsense value with spaces' })).toBe('rejected')
    expect(rejectedProviderResponse(undefined)).toBeUndefined()
  })
})

describe('inbound normalization', () => {
  const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ message_id: 'msg-1', from_user_id: 'user-1',
    message_type: 1, item_list: [{ type: 1, text_item: { text: 'please fix the typo' } }], context_token: 'ctx-1',
    run_id: 'run-1', create_time_ms: 1_764_115_200_000, ...overrides })
  it('normalizes a direct text message with its ids, conversation token and time', () => {
    expect(normalizeWeixinInbound(raw())).toEqual({ message: { messageId: 'msg-1', clientId: '', text: 'please fix the typo',
      fromUserId: 'user-1', conversationKind: 'dm', addressed: true, contextToken: 'ctx-1', runId: 'run-1',
      createdAt: '2025-11-26T00:00:00.000Z' } })
    // A numeric message id and a voice transcript are accepted; the text is cut at the Trigger limit.
    expect(normalizeWeixinInbound(raw({ message_id: 12, client_id: 'client-1',
      item_list: [{ type: 3, voice_item: { text: 'hello' } }], create_time_ms: undefined })))
      .toMatchObject({ message: { messageId: '12', clientId: 'client-1', text: 'hello', createdAt: '' } })
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 1, text_item: { text: 'x'.repeat(9_000) } }] })))
      .toMatchObject({ message: { text: 'x'.repeat(WEIXIN_TEXT_CHARS) } })
  })
  it('skips the account\'s own messages, group messages, non-text messages and malformed ones', () => {
    expect(normalizeWeixinInbound(raw({ message_type: 2 }))).toEqual({ skipped: { reason: 'self', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ chatroom_id: 'room-1' }))).toEqual({ skipped: { reason: 'group', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ room_id: 'room-1' }))).toEqual({ skipped: { reason: 'group', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 2, image_item: {} }] })))
      .toEqual({ skipped: { reason: 'non-text', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ from_user_id: undefined }))).toEqual({ skipped: { reason: 'invalid', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ message_id: undefined, client_id: undefined }))).toEqual({ skipped: { reason: 'invalid' } })
    expect(normalizeWeixinInbound(null)).toEqual({ skipped: { reason: 'invalid' } })
    expect(normalizeWeixinInbound([])).toEqual({ skipped: { reason: 'invalid' } })
  })
})

describe('the login manager', () => {
  /** A fake iLink that returns one QR token and then the given statuses in order. */
  function fakeLogin(statuses: string[]): { fetchImpl: typeof fetch; calls: FakeCall[] } {
    const queue = [...statuses]
    return fakeFetch(call => {
      if (call.url.includes('get_bot_qrcode')) {
        return { body: { qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr.png' } }
      }
      const status = queue.shift() ?? 'wait'
      return { body: status === 'confirmed' ? { status, bot_token: 'bot-token-1', ilink_bot_id: 'bot-1', ilink_user_id: 'user-1' }
        : { status } }
    })
  }
  it('polls an attempt to scanned and confirmed, then writes the one credential and reports the account id', async () => {
    const { fetchImpl } = fakeLogin(['wait', 'scaned', 'confirmed'])
    const manager = new WeixinLoginManager({ fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      const saves: WeixinCredential[] = []
      const started = await manager.start('wechat:ops', { save: save => { saves.push(save) } })
      expect(started.qrImage).toBe('https://weixin.qq.com/qr.png')
      expect(manager.status('wechat:ops', started.loginId).status).toBe('wait')
      await vi.waitFor(() => expect(manager.status('wechat:ops', started.loginId))
        .toMatchObject({ status: 'confirmed', ilinkBotId: 'bot-1' }))
      expect(saves).toEqual([{ token: 'bot-token-1', ilinkBotId: 'bot-1', at: expect.any(String) }])
      // Only this instance's latest attempt is readable; a foreign or unknown attempt reads expired.
      expect(manager.status('wechat:other', started.loginId)).toEqual({ status: 'expired' })
      expect(manager.status('wechat:ops', 'unknown')).toEqual({ status: 'expired' })
    } finally { manager.clear() }
  })
  it('renders a QR content that is not an image URL as a data URL', async () => {
    const fetchImpl = fakeFetch(() => ({ body: { qrcode: 'qr-1', qrcode_img_content: 'weixin://scan?token=1' } })).fetchImpl
    const manager = new WeixinLoginManager({ fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      const started = await manager.start('wechat', { save: () => {} })
      expect(started.qrImage.startsWith('data:image/png;base64,')).toBe(true)
    } finally { manager.clear() }
  })
  it('keeps only the newest attempt per instance, and reports an expired poll as expired', async () => {
    const waiting = fakeFetch(call => call.url.includes('get_bot_qrcode')
      ? { body: { qrcode: 'qr', qrcode_img_content: 'https://weixin.qq.com/qr.png' } }
      : { body: { status: 'wait' } })
    const manager = new WeixinLoginManager({ fetchImpl: waiting.fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      const first = await manager.start('wechat', { save: () => {} })
      const second = await manager.start('wechat', { save: () => {} })
      expect(manager.status('wechat', first.loginId)).toEqual({ status: 'expired' })
      expect(manager.status('wechat', second.loginId).status).toBe('wait')
      // An attempt whose TTL passed is expired without another upstream call.
      const short = new WeixinLoginManager({ fetchImpl: waiting.fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100, ttlMs: 20 })
      try {
        const attempt = await short.start('wechat', { save: () => {} })
        await vi.waitFor(() => expect(short.status('wechat', attempt.loginId).status).toBe('expired'))
      } finally { short.clear() }
    } finally { manager.clear() }
  })
  it('reports a failed poll with its reason and an upstream failure as a failed attempt', async () => {
    const expired = fakeLogin(['expired'])
    const manager = new WeixinLoginManager({ fetchImpl: expired.fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      const attempt = await manager.start('wechat', { save: () => {} })
      await vi.waitFor(() => expect(manager.status('wechat', attempt.loginId).status).toBe('expired'))
    } finally { manager.clear() }
    const failed = new WeixinLoginManager({ fetchImpl: fakeLogin(['need_verifycode']).fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      const attempt = await failed.start('wechat', { save: () => {} })
      await vi.waitFor(() => expect(failed.status('wechat', attempt.loginId)).toMatchObject({ status: 'failed',
        error: expect.stringContaining('need_verifycode') }))
    } finally { failed.clear() }
    const broken = new WeixinLoginManager({ fetchImpl: fakeFetch(() => new Error('socket closed')).fetchImpl,
      pollIntervalMs: 1, pollTimeoutMs: 100 })
    try {
      await expect(broken.start('wechat', { save: () => {} })).rejects.toBeInstanceOf(WeixinApiError)
    } finally { broken.clear() }
  })
  it('reads the credential record key by instance', () => {
    expect(weixinToken('wechat:ops')).toBe('weixin.token:wechat:ops')
  })
})
