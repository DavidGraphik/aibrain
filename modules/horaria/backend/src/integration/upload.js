import multer from 'multer';

// The bridge has already authenticated and parsed the exact multipart bytes.
// Keep the original per-route field and file-size checks and the standalone tests.
export default function upload(options) {
  const fallback = multer(options);
  return { single(field) {
    return (req, res, next) => {
      if (!req.horariaUploads) return fallback.single(field)(req, res, next);
      const files = req.horariaUploads;
      if (files.length > 1 || files.some(file => file.fieldname !== field)) return res.status(400).json({ error: 'Unexpected file' });
      if (files.some(file => file.size > options.limits.fileSize)) return res.status(413).json({ error: 'File too large' });
      req.file = files[0];
      next();
    };
  } };
}
upload.memoryStorage = multer.memoryStorage;
