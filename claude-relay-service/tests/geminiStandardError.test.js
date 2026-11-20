jest.mock('../src/utils/logger', () => ({ debug: jest.fn() }), { virtual: true })
const { sendStandardGeminiError } = require('../src/utils/geminiStandardError')
const fs = require('fs')
const vm = require('vm')
const path = require('path')

function response() {
  const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}
function failure(status, retryAfter, message = 'private prompt token https://secret.invalid') {
  return {
    message,
    response: {
      status,
      headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      data: { error: { message: 'private upstream body' } }
    }
  }
}

describe('standard Gemini error response', () => {
  it('OAuth上游429保留429和合法Retry-After，不再被handler固定压500', () => {
    const res = response()
    sendStandardGeminiError(res, failure(429, '120'))
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '120')
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'E004', message: 'Rate limit exceeded', type: 'api_error' }
    })
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/private|secret|token/)
  })

  it('原503不被含timeout的原文改成504，仍只返回安全白名单信息', () => {
    const res = response()
    sendStandardGeminiError(res, failure(503, '9', 'timeout private credential'))
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '9')
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'E001', message: 'Service temporarily unavailable', type: 'api_error' }
    })
  })

  it('未知异常仍为500，不泄露原文、上游body、堆栈或credentials', () => {
    const res = response()
    sendStandardGeminiError(res, new Error('private token timeout capacity URL detail'))
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'E015', message: 'Internal server error', type: 'api_error' }
    })
    expect(res.setHeader).not.toHaveBeenCalled()
  })

  it.each([
    [429, 'capacity private token', 'E004'],
    [503, '429 rate limit private', 'E001'],
    [504, 'rate limit private token', 'E008']
  ])('HTTP状态%s不会被原文关键词覆写', (status, message, code) => {
    const res = response()
    sendStandardGeminiError(res, failure(status, undefined, message))
    expect(res.status).toHaveBeenCalledWith(status)
    expect(res.json.mock.calls[0][0].error.code).toBe(code)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private')
  })

  it('Retry-After HTTP日期转换为等待秒，不把1小时本地账户策略冒充上游值', () => {
    const res = response()
    sendStandardGeminiError(
      res,
      failure(429, 'Mon, 09 Nov 2026 03:31:09 GMT'),
      Date.parse('2026-11-09T03:30:09Z')
    )
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60')
    const absent = response()
    sendStandardGeminiError(absent, failure(429))
    expect(absent.setHeader).not.toHaveBeenCalled()
  })

  it.each(['120private', '120\r\nAuthorization: private', '-1', ['10'], 'Infinity'])(
    '无效Retry-After不进入响应头：%s',
    (raw) => {
      const res = response()
      sendStandardGeminiError(res, failure(429, raw))
      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.setHeader).not.toHaveBeenCalled()
    }
  )

  it('兼容AxiosHeaders.get、合法0秒以及过期日期', () => {
    for (const raw of ['0', 'Mon, 09 Nov 2026 03:29:09 GMT']) {
      const res = response()
      const error = failure(429)
      error.response.headers = { get: () => raw }
      sendStandardGeminiError(res, error, Date.parse('2026-11-09T03:30:09Z'))
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '0')
    }
  })

  it.each([429, 503, undefined])(
    '实际OAuth handler沿正常调度调用后安全保留失败语义：%s',
    async (status) => {
      const error = status ? failure(status, '60') : new Error('private unknown detail')
      const generateContent = jest.fn(async () => {
        throw error
      })
      const markAccountRateLimited = jest.fn(async () => undefined)
      const markTempUnavailable = jest.fn(async () => undefined)
      const axios = jest.fn(() => {
        throw new Error('REAL_HTTP_FORBIDDEN')
      })
      const logger = new Proxy({}, { get: () => jest.fn() })
      const scheduler = {
        selectAccountForApiKey: jest.fn(async () => ({
          accountId: 'oauth-only',
          accountType: 'gemini'
        })),
        markAccountRateLimited,
        _deleteSessionMapping: jest.fn(async () => undefined)
      }
      const modules = {
        '../utils/logger': logger,
        '../services/account/geminiAccountService': {
          getAccount: async () => ({
            id: 'oauth-only',
            oauthProvider: 'gemini-cli',
            projectId: 'owned-project'
          }),
          getOauthClient: async () => ({}),
          generateContent
        },
        '../services/scheduler/unifiedGeminiScheduler': scheduler,
        '../services/apiKeyService': { hasPermission: () => true },
        '../utils/sessionHelper': { generateSessionHash: () => 'mock-session' },
        '../utils/upstreamErrorHelper': { parseRetryAfter: () => 60, markTempUnavailable },
        '../utils/errorSanitizer': require('../src/utils/errorSanitizer'),
        '../utils/geminiStandardError': { sendStandardGeminiError },
        crypto: { randomUUID: () => 'mock-user-prompt' },
        axios
      }
      const exported = { exports: {} }
      vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../src/handlers/geminiHandlers.js'), 'utf8'),
        {
          require: (id) => modules[id] ?? {},
          module: exported,
          Buffer,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval
        }
      )
      const res = response()
      await exported.exports.handleStandardGenerateContent(
        {
          apiKey: { id: 'mock-key', permissions: ['gemini'] },
          path: '/v1beta/models/gemini-3-pro-image:generateContent',
          params: { modelName: 'gemini-3-pro-image' },
          body: { contents: [{ role: 'user', parts: [{ text: 'mock prompt' }] }] }
        },
        res
      )
      expect(generateContent).toHaveBeenCalledTimes(1)
      expect(axios).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(status ?? 500)
      expect(JSON.stringify(res.json.mock.calls)).not.toMatch(
        /private|credential|owned-project|mock-key/
      )
      if (status === 429) {
        expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60')
        expect(markAccountRateLimited).toHaveBeenCalledTimes(1)
        expect(markTempUnavailable).toHaveBeenCalledWith('oauth-only', 'gemini', 429, 60)
      } else expect(markAccountRateLimited).not.toHaveBeenCalled()
    }
  )
})
