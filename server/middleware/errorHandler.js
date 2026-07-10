const { GhlApiError } = require('../lib/ghlClient');

function errorHandler(err, req, res, next) {
  if (err instanceof GhlApiError) {
    return res.status(err.status && err.status < 600 ? err.status : 502).json({
      error: err.message,
      details: err.details,
    });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
}

module.exports = errorHandler;
