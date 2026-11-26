/**
 * Credential field detection shared by the management panel and the settings history: a Source configuration field
 * whose key names a credential is rendered as a password input, summarized as set, and never recorded by value.
 */
const SECRET_KEY = /(?:secret|token|password|passwd|apikey|aeskey)/i
/** Whether a Source configuration field's value is a credential that must never be shown or recorded. */
export const isSecretKey = (key: string): boolean => SECRET_KEY.test(key)
