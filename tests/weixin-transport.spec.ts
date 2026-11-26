/**
 * The WeChat iLink transport and its QR sign-in sessions, without WeChat: the wire payloads, headers and status mapping over
 * a fake fetch, inbound normalization (text, pictures and files), the AES key parsing, `aes-128-ecb` decryption and the
 * bounded CDN attachment download, text splitting, and the login manager's background poll writing one credential.
 */
import { createCipheriv } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginWeixinLogin, clearWeixinLiveCredentials, decryptWeixinAttachment, downloadWeixinAttachment, getWeixinUpdates,
  liveWeixinCredential, normalizeWeixinInbound, parseWeixinAesKey, pollWeixinLogin, rejectedProviderResponse,
  registerWeixinCredential, sendWeixinReply, sendWeixinText, sniffWeixinImageMime, splitWeixinText, trustedWeixinUrl,
  unregisterWeixinCredential, WEIXIN_ATTACHMENT_BYTES, WEIXIN_PROTOCOL_VERSION, WEIXIN_REPLY_CHARS, WEIXIN_TEXT_CHARS,
  weixinAttachmentDownloadUrl, weixinClientId, weixinReplyTargetOf, WeixinApiError, type WeixinAttachmentRef,
} from '../src/sources/im/weixin-transport.ts'
import { renderWeixinQrImage, WEIXIN_QR_IMAGE_BYTES, WeixinLoginManager, weixinToken,
  type WeixinCredential } from '../src/sources/im/weixin-login.ts'

interface FakeCall { url: string; method: string; headers: Record<string, string>; body: unknown
  redirect: RequestRedirect | undefined }
type Answer = { status?: number; body: unknown } | { response: Response } | Error
/** A fake fetch that records each call and answers from a callback; a thrown Error is a socket-level failure. */
function fakeFetch(answer: (call: FakeCall) => Answer | Promise<Answer>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = { url: String(input), method: init?.method ?? 'GET',
      headers: { ...(init?.headers ?? {}) as Record<string, string> },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined, redirect: init?.redirect }
    calls.push(call)
    const result = await answer(call)
    if (result instanceof Error) throw result
    if ('response' in result) return result.response
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

/** A PNG answer for a trusted QR image URL, as iLink serves one; the test's assertions only need a data URL back. */
const QR_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const qrPngResponse = (): Response => new Response(new Uint8Array(QR_PNG), { status: 200,
  headers: { 'content-type': 'image/png' } })
/** The AES-128 key and fixture iLink encrypts an inbound attachment with; the tests use it locally, never a network. */
const AES_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')/** Encrypts bytes as iLink does: AES-128-ECB with PKCS#7 padding, so the ciphertext is whole blocks. */
function encryptAttachment(data: string | Buffer, key = AES_KEY): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()])
}
const base64Key = (key = AES_KEY): string => key.toString('base64')
/** One attachment reference whose bytes the fake CDN answers with; a picture by default. */
const attachmentRef = (overrides: Partial<WeixinAttachmentRef> = {}): WeixinAttachmentRef => ({ kind: 'image',
  media: { encryptQueryParam: 'encrypted-query', fullUrl: '', aesKey: '', aeskey: AES_KEY.toString('hex') }, name: '', bytes: 0,
  ...overrides })
/** The error a synchronous refusal threw, for its class and code. */
function failureOf(run: () => unknown): unknown {
  try { run() } catch (error) { return error }
  return undefined
}
/** One recorded attachment-download call: its URL, HTTP method and redirect mode. */
interface DownloadCall { url: string; method: string; redirect: RequestRedirect | undefined }
/** A fake `fetch` answering whole `Response` objects; `'network'` is a socket-level failure. */
function downloadFetch(handler: (call: DownloadCall) => Response | 'network'): { impl: typeof fetch; calls: DownloadCall[] } {
  const calls: DownloadCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: DownloadCall = { url: String(input), method: init?.method ?? 'GET', redirect: init?.redirect }
    calls.push(call)
    const answer = handler(call)
    if (answer === 'network') throw new TypeError('fetch failed')
    return answer
  }) as unknown as typeof fetch
  return { impl, calls }
}
/** A binary answer carrying already-encrypted bytes, so the transport must decrypt them itself. */
const encryptedResponse = (data: string | Buffer, type?: string, key = AES_KEY): Response =>
  new Response(new Uint8Array(encryptAttachment(data, key)),
    { status: 200, ...type ? { headers: { 'content-type': type } } : {} })

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
      attachments: [], fromUserId: 'user-1', conversationKind: 'dm', addressed: true, contextToken: 'ctx-1', runId: 'run-1',
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
    // A video or an empty item is still the only non-text skip: a picture or a file now names work.
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 5, video_item: {} }] })))
      .toEqual({ skipped: { reason: 'non-text', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ from_user_id: undefined }))).toEqual({ skipped: { reason: 'invalid', messageId: 'msg-1' } })
    expect(normalizeWeixinInbound(raw({ message_id: undefined, client_id: undefined }))).toEqual({ skipped: { reason: 'invalid' } })
    expect(normalizeWeixinInbound(null)).toEqual({ skipped: { reason: 'invalid' } })
    expect(normalizeWeixinInbound([])).toEqual({ skipped: { reason: 'invalid' } })
  })
})

describe('inbound attachments', () => {
  const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ message_id: 'msg-1', from_user_id: 'user-1',
    message_type: 1, item_list: [{ type: 1, text_item: { text: 'please fix the typo' } }], context_token: 'ctx-1',
    run_id: 'run-1', create_time_ms: 1_764_115_200_000, ...overrides })
  const media = (overrides: Partial<WeixinAttachmentRef['media']> = {}): WeixinAttachmentRef['media'] => ({
    encryptQueryParam: 'encrypted-query', fullUrl: '', aesKey: '', aeskey: AES_KEY.toString('hex'), ...overrides })
  it('normalizes image and file items into attachments and keeps an attachment-only message as work', () => {
    const inbound = normalizeWeixinInbound(raw({ item_list: [
      { type: 1, text_item: { text: 'look at these' } },
      { type: 2, image_item: { aeskey: AES_KEY.toString('hex'), media: { encrypt_query_param: 'image-query',
        aes_key: base64Key() } } },
      { type: 4, file_item: { file_name: 'report.pdf', len: '120', aeskey: 'f'.repeat(32),
        media: { encrypt_query_param: 'file-query' } } },
    ] }))
    expect(inbound).toMatchObject({ message: { text: 'look at these', attachments: [
      { kind: 'image', name: '', bytes: 0, media: { encryptQueryParam: 'image-query', aesKey: base64Key(),
        aeskey: AES_KEY.toString('hex') } },
      { kind: 'file', name: 'report.pdf', bytes: 120, media: { encryptQueryParam: 'file-query',
        aeskey: 'f'.repeat(32) } },
    ] } })
    // A message carrying only a picture is work, not a non-text skip; the same is true for a file.
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'x' } } }] })))
      .toMatchObject({ message: { text: '', attachments: [{ kind: 'image', media: { encryptQueryParam: 'x' } }] } })
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 4, file_item: { file_name: 'a.txt', len: '3',
      media: { encrypt_query_param: 'y' } } }] })))
      .toMatchObject({ message: { text: '', attachments: [{ kind: 'file', name: 'a.txt', bytes: 3 }] } })
    // An item this client cannot read still names an attachment, so the message becomes a counted skip, not non-text.
    expect(normalizeWeixinInbound(raw({ item_list: [{ type: 2, image_item: {} }] })))
      .toMatchObject({ message: { text: '', attachments: [{ kind: 'image', media: { encryptQueryParam: '' } }] } })
  })
  it('parses the aeskey hex and media.aes_key base64 key forms and refuses a malformed one', () => {
    expect(parseWeixinAesKey({ aeskey: AES_KEY.toString('hex') })).toEqual(AES_KEY)
    expect(parseWeixinAesKey({ media: { aes_key: base64Key() } })).toEqual(AES_KEY)
    // iLink also base64-encodes the 32 hex digits of a key.
    expect(parseWeixinAesKey({ media: { aes_key: Buffer.from(AES_KEY.toString('hex')).toString('base64') } })).toEqual(AES_KEY)
    for (const item of [{}, { aeskey: 'not-hex' }, { media: { aes_key: 'not base64!' } },
      { media: { aes_key: Buffer.alloc(8).toString('base64') } }]) {
      expect(failureOf(() => parseWeixinAesKey(item))).toMatchObject({ name: 'WeixinAttachmentError', code: 'invalid-key' })
    }
  })
  it('decrypts aes-128-ecb ciphertext and refuses a body that is not whole AES blocks', () => {
    const plaintext = Buffer.from('hello wechat attachment')
    const ciphertext = encryptAttachment(plaintext)
    expect(decryptWeixinAttachment(ciphertext, AES_KEY)).toEqual(plaintext)
    // A body that is not whole AES blocks and a key of the wrong length both fail before decrypting.
    for (const [bytes, key] of [[Buffer.from('short'), AES_KEY],
      [Buffer.concat([ciphertext, Buffer.from([1])]), AES_KEY], [ciphertext, Buffer.alloc(15)]] as const) {
      expect(failureOf(() => decryptWeixinAttachment(bytes, key))).toMatchObject({ name: 'WeixinAttachmentError',
        code: 'decryption-failed' })
    }
  })
  it('builds only the trusted encrypted-CDN download address', () => {
    const urlOf = (overrides: Partial<WeixinAttachmentRef['media']>): string => weixinAttachmentDownloadUrl(media(overrides))
    expect(urlOf({ encryptQueryParam: 'a b&c' }))
      .toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%20b%26c')
    // A full URL is followed only on the exact CDN host, over HTTPS, with no credentials, port or foreign path.
    expect(urlOf({ encryptQueryParam: '', fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x#frag' }))
      .toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x')
    for (const fullUrl of ['http://novac2c.cdn.weixin.qq.com/c2c/x', 'https://evil.example/c2c/x',
      'https://novac2c.cdn.weixin.qq.com.evil.example/c2c/x', 'https://user:pass@novac2c.cdn.weixin.qq.com/c2c/x',
      'https://novac2c.cdn.weixin.qq.com:8443/c2c/x', 'https://novac2c.cdn.weixin.qq.com/other/x']) {
      expect(urlOf({ encryptQueryParam: '', fullUrl })).toBe('')
    }
    expect(urlOf({ encryptQueryParam: '', fullUrl: '' })).toBe('')
  })
  it('downloads and decrypts an attachment from the encrypted CDN address', async () => {
    const plaintext = Buffer.from('image-bytes')
    const stub = downloadFetch(() => encryptedResponse(plaintext, 'image/jpeg'))
    expect(await downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: stub.impl }))
      .toEqual({ data: plaintext, mime: 'image/jpeg', name: '' })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(stub.calls[0]!.url)
      .toContain('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=encrypted-query')
    // A media.aes_key base64 key decrypts the same fixture; a trusted full URL is used when no query parameter came.
    expect(await downloadWeixinAttachment({ attachment: attachmentRef({ media: media({ aeskey: '', aesKey: base64Key() }) }),
      fetchImpl: stub.impl })).toMatchObject({ data: plaintext })
    const full = downloadFetch(() => encryptedResponse('x'))
    await downloadWeixinAttachment({ attachment: attachmentRef({ kind: 'file', name: 'report.pdf',
      media: media({ encryptQueryParam: '', fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=full' }) }),
    fetchImpl: full.impl })
    expect(full.calls[0]!.url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=full')
    // The answer's Content-Type only survives as a MIME type when the decrypted bytes are not a sniffable picture first.
    expect((await downloadWeixinAttachment({ attachment: attachmentRef({ kind: 'file', name: 'report.pdf' }),
      fetchImpl: downloadFetch(() => encryptedResponse('%PDF-1.4', 'application/pdf; charset=binary')).impl })))
      .toMatchObject({ mime: 'application/pdf', name: 'report.pdf' })
  })
  it('names a picture from its decrypted bytes and keeps an unknown type untyped', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const sniffed = downloadFetch(() => encryptedResponse(png, 'application/octet-stream'))
    expect((await downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: sniffed.impl })).mime).toBe('image/png')
    expect(sniffWeixinImageMime(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffWeixinImageMime(Buffer.from('%PDF-1.4'))).toBe('')
    // A picture whose bytes are unknown and whose answer declares no image type stays octet-stream.
    const unknown = downloadFetch(() => encryptedResponse('unknown-bytes'))
    expect((await downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: unknown.impl })).mime)
      .toBe('application/octet-stream')
  })
  it('refuses a missing or untrusted address and a malformed key before any request', async () => {
    await expect(downloadWeixinAttachment({ attachment: attachmentRef({ media: media({ encryptQueryParam: '', fullUrl: '' }) }) }))
      .rejects.toMatchObject({ name: 'WeixinAttachmentError', code: 'unavailable' })
    const untrusted = downloadFetch(() => encryptedResponse('x'))
    await expect(downloadWeixinAttachment({ attachment: attachmentRef({ media: media({ encryptQueryParam: '',
      fullUrl: 'https://evil.example/c2c/x' }) }), fetchImpl: untrusted.impl }))
      .rejects.toMatchObject({ code: 'untrusted-url' })
    await expect(downloadWeixinAttachment({ attachment: attachmentRef({ media: media({ aeskey: 'bad' }) }) }))
      .rejects.toMatchObject({ code: 'invalid-key' })
    await expect(downloadWeixinAttachment({ attachment: attachmentRef({ bytes: WEIXIN_ATTACHMENT_BYTES + 1 }) }))
      .rejects.toMatchObject({ code: 'too-large' })
    expect(untrusted.calls).toEqual([])
  })
  it('reports a redirect, a failed download and an undecryptable body with their own kind, without the signed address', async () => {
    const redirected = downloadFetch(() => 'network')
    await expect(downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: redirected.impl }))
      .rejects.toMatchObject({ code: 'download-failed' })
    expect(redirected.calls[0]).toMatchObject({ method: 'GET', redirect: 'error' })
    await expect(downloadWeixinAttachment({ attachment: attachmentRef(),
      fetchImpl: downloadFetch(() => new Response('', { status: 503 })).impl }))
      .rejects.toMatchObject({ code: 'download-failed', status: 503 })
    const broken = downloadFetch(() => new Response('not-an-aes-block'))
    const failure = await downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: broken.impl })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'decryption-failed' })
    // Neither the signed query string nor the AES key appears in a failure.
    expect(String((failure as Error).message)).not.toContain('encrypted-query')
    expect(String((failure as Error).message)).not.toContain(AES_KEY.toString('hex'))
  })
  it('stops a streamed body over 20 MiB plus one AES block and keeps none of it', async () => {
    const huge = downloadFetch(() => new Response(new Uint8Array(WEIXIN_ATTACHMENT_BYTES + 17)))
    await expect(downloadWeixinAttachment({ attachment: attachmentRef(), fetchImpl: huge.impl }))
      .rejects.toMatchObject({ code: 'too-large' })
    await expect(downloadWeixinAttachment({ attachment: attachmentRef({ bytes: WEIXIN_ATTACHMENT_BYTES + 1 }) }))
      .rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('the QR image the panel shows', () => {
  /** A fake iLink whose QR content is `content`; a non-status GET answers `image`, or fails when it is `'network'`. */
  function qrFetch(content: string, image?: () => Response | 'network'): { fetchImpl: typeof fetch; calls: FakeCall[] } {
    return fakeFetch(call => {
      if (call.url.includes('get_bot_qrcode')) return { body: { qrcode: 'qr-1', qrcode_img_content: content } }
      if (call.url.includes('get_qrcode_status')) return { body: { status: 'wait' } }
      if (image === undefined) return new Error('the QR content is not a URL')
      const answer = image()
      return answer === 'network' ? new Error('socket closed') : { response: answer }
    })
  }
  /** Starts one attempt over `fetchImpl` and records what the QR renderer was asked to draw. */
  async function start(fetchImpl: typeof fetch): Promise<{ qrImage: string; rendered: string[] }> {
    const rendered: string[] = []
    const manager = new WeixinLoginManager({ fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 100,
      renderQr: async content => { rendered.push(content); return `rendered:${content}` } })
    try {
      const started = await manager.start('wechat', { save: () => {} })
      return { qrImage: started.qrImage, rendered }
    } finally { manager.clear() }
  }
  it('fetches a trusted image URL once without following a redirect and returns it as a data URL', async () => {
    const { fetchImpl, calls } = qrFetch('https://weixin.qq.com/qr.png', qrPngResponse)
    const { qrImage, rendered } = await start(fetchImpl)
    expect(qrImage).toBe(`data:image/png;base64,${QR_PNG.toString('base64')}`)
    expect(rendered).toEqual([])
    expect(calls.find(call => call.url === 'https://weixin.qq.com/qr.png')).toMatchObject({ method: 'GET', redirect: 'error' })
  })
  it('renders a trusted URL that answered a landing page instead of loading the page as an image', async () => {
    const landing = 'https://weixin.qq.com/qr/landing'
    const { fetchImpl, calls } = qrFetch(landing, () => new Response('<!doctype html><title>scan</title>', { status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' } }))
    expect((await start(fetchImpl)).qrImage).toBe(`rendered:${landing}`)
    expect(calls.filter(call => call.url === landing)).toHaveLength(1)
  })
  it('renders ordinary QR text and passes a data URL through unchanged', async () => {
    expect((await start(qrFetch('weixin://scan?token=1').fetchImpl)).qrImage).toBe('rendered:weixin://scan?token=1')
    const data = 'data:image/png;base64,AAAA'
    const passthrough = await start(qrFetch(data).fetchImpl)
    expect(passthrough.qrImage).toBe(data)
    expect(passthrough.rendered).toEqual([])
  })
  it('falls back to rendering the URL text when the image fetch fails or answers more than 1 MiB', async () => {
    const url = 'https://weixin.qq.com/qr.png'
    expect((await start(qrFetch(url, () => 'network').fetchImpl)).qrImage).toBe(`rendered:${url}`)
    const huge = qrFetch(url, () => new Response('x', { status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(WEIXIN_QR_IMAGE_BYTES + 1) } }))
    expect((await start(huge.fetchImpl)).qrImage).toBe(`rendered:${url}`)
  })
})

describe('the login manager', () => {
  /** A fake iLink that returns one QR token and then the given statuses in order; its QR image URL answers a PNG. */
  function fakeLogin(statuses: string[]): { fetchImpl: typeof fetch; calls: FakeCall[] } {
    const queue = [...statuses]
    return fakeFetch(call => {
      if (call.url.includes('get_bot_qrcode')) {
        return { body: { qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr.png' } }
      }
      if (!call.url.includes('get_qrcode_status')) return { response: qrPngResponse() }
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
      // The trusted HTTPS image URL is fetched once and handed to the panel as a data URL.
      expect(started.qrImage).toBe(`data:image/png;base64,${QR_PNG.toString('base64')}`)
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
