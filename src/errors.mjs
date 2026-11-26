// 统一的 HTTP 业务错误，携带中文提示与状态码。
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? 'business_error';
  }
}

export const badRequest = (message, code = 'bad_request') => new HttpError(400, message, code);
export const unauthorized = (message = '缺少或无效的 x-actor-id 身份头') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message, code = 'forbidden') => new HttpError(403, message, code);
export const notFound = (message) => new HttpError(404, message, 'not_found');
export const conflict = (message) => new HttpError(409, message, 'conflict');
export const unprocessable = (message, code = 'unprocessable') => new HttpError(422, message, code);

// 金额一律为正整数（分）。
export function parseAmount(value, label = '金额') {
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${label}必须为正整数（分）`);
  return value;
}

export function requireReason(body) {
  if (typeof body.reason !== 'string' || !body.reason.trim()) {
    throw badRequest('必须填写业务原因 reason');
  }
  return body.reason.trim();
}

export function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw badRequest(`缺少必填字段 ${field}`);
    }
  }
}
