// Preserve the callable CommonJS interface expected by Expo SDK 55 query-string.
const decoder = require('patched-uri-decoder');
module.exports = decoder.default;
