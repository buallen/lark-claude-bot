'use strict';

module.exports = {
  MSG_AGE_LIMIT_MS:      60_000,           // ignore messages older than this
  TMP_FILE_CLEANUP_MS:   5 * 60 * 1000,    // delete temp images after 5 min
  STREAM_TIMER_MS:       2_000,            // patch interval during streaming
  STREAM_PREVIEW_CHARS:  2_000,            // max chars shown in streaming preview
  TIMER_FAIL_THRESHOLD:  3,               // stop timer after N consecutive patch failures
  CLAUDE_TIMEOUT_MS:     10 * 60 * 1000,  // Claude hard timeout
  SIGKILL_GRACE_MS:      5_000,           // wait before SIGKILL after SIGTERM
  CARD_ELEMENT_LIMIT:    800,             // max chars per card markdown element
  STDERR_CAP:            8_192,           // max stderr bytes kept
  MAX_INPUT_LENGTH:      10_000,          // reject prompts longer than this
  MAX_PROCESSED_IDS:     500,             // dedup set size cap
  CHUNK_LIMIT:           1000,            // max chars per message chunk
  HEALTH_PORT:           9090,            // health check HTTP port
  RATE_LIMIT_MAX:        20,              // max requests per user per window
  RATE_LIMIT_WINDOW_MS:  60_000,          // rate limit window duration
};
