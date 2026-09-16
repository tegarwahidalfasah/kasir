// Helper error & async wrapper untuk Express 5.
export class AppError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new AppError(400, msg, details);
export const unauthorized = (msg = 'Sesi berakhir, silakan masuk kembali') => new AppError(401, msg);
export const forbidden = (msg = 'Anda tidak punya hak akses untuk aksi ini') => new AppError(403, msg);
export const notFound = (msg = 'Data tidak ditemukan') => new AppError(404, msg);
export const conflict = (msg, details) => new AppError(409, msg, details);

/** Bungkus handler async supaya error/throw dikirim sebagai JSON. */
export const http = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};
