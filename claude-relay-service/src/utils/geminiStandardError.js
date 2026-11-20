const { createSafeErrorResponse } = require('./errorSanitizer')

// 只保留 HTTP 错误语义与标准安全文案，禁止透传上游正文、URL 或认证信息。
function sendStandardGeminiError(res, error, now = Date.now()) {
  const upstreamStatus = error?.response?.status
  const status =
    Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
      ? upstreamStatus
      : undefined
  // 原始 HTTP 状态优先，不能让原文里的 timeout 等字样把429/503重分类。
  const safe = createSafeErrorResponse(
    status
      ? { response: { status } }
      : {
          code: typeof error?.code === 'string' ? error.code : undefined
        },
    {
      context: 'standard-gemini-generate',
      logOriginal: false
    }
  )
  const responseStatus = status ?? safe.status
  if (responseStatus === 429 || responseStatus === 503) {
    const retryAfter = safeRetryAfter(error?.response?.headers, now)
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter))
    }
  }
  return res.status(responseStatus).json({
    error: { ...safe.error, type: 'api_error' }
  })
}

// 这里是向调用方传递上游等待指示，不使用账户默认1h或temp-unavailable钳制值。
// 秒值或IMF-fixdate归一为有限非负整数；任意字符串、数组、CRLF均不能进入响应头。
function safeRetryAfter(headers, now) {
  if (!headers) {
    return undefined
  }
  const raw =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : (headers['retry-after'] ?? headers['Retry-After'])
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined
  }
  const value = String(raw).trim()
  if (/^\d{1,15}$/u.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) ? seconds : undefined
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      value
    )
  ) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.ceil((parsed - now) / 1000)) : undefined
}

module.exports = { sendStandardGeminiError }
