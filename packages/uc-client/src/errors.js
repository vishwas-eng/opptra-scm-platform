export class UcError extends Error {
  constructor(path, http, msg) {
    super(`${path} -> [${http}] ${msg}`);
    this.name = 'UcError';
    this.path = path;
    this.http = http;
  }
}

// Thrown ONLY on real session death (401 / login redirect / USER_NOT_LOGGED_IN).
// A `successful:false` body (e.g. wrong facility) is NOT session death — hard-won
// lesson from the b2b webapp @53 fix. Never widen this classification.
export class SessionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SessionError';
  }
}

export class ConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConfigError';
  }
}
