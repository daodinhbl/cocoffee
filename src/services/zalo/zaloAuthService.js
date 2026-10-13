const axios = require('axios');
const env = require('../../config/env');
const { withTransaction } = require('../../config/db');
const { tokenModel } = require('../../models/zaloModel');
const { AppError } = require('../../utils/httpError');
const logger = require('../../utils/logger');

/**
 * Zalo OA access tokens live 25h; refresh tokens live 3 months and are SINGLE-USE
 * (each refresh returns a new pair). So the pair is persisted in `zalo_tokens` and refreshed
 * under a row lock: if two Passenger workers race, the second one finds a fresh token and skips.
 */
async function callRefreshEndpoint(refreshToken) {
  const res = await axios.post(
    env.zalo.oauthUrl,
    new URLSearchParams({ refresh_token: refreshToken, app_id: env.zalo.appId, grant_type: 'refresh_token' }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: env.zalo.appSecretKey },
      timeout: 10000,
      validateStatus: () => true,
    }
  );
  const d = res.data || {};
  if (!d.access_token || !d.refresh_token) {
    throw new AppError(502, 'ZALO_REFRESH_FAILED', `Zalo token refresh failed: ${JSON.stringify(d).slice(0, 300)}`);
  }
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresInSeconds: Number(d.expires_in) || 90000 };
}

/** @param {string} [staleToken] when set, refresh only if the stored token is still that one */
async function refresh(staleToken) {
  return withTransaction(async (conn) => {
    const row = await tokenModel.get(conn, { forUpdate: true });
    if (row && staleToken && row.access_token !== staleToken) return row.access_token;       // someone else refreshed
    if (row && !staleToken && !row.needs_refresh) return row.access_token;

    const refreshToken = row?.refresh_token || env.zalo.bootstrapRefreshToken;
    if (!refreshToken) throw new AppError(503, 'ZALO_NOT_AUTHORIZED', 'No Zalo refresh token. Set ZALO_BOOTSTRAP_REFRESH_TOKEN once.');

    const tokens = await callRefreshEndpoint(refreshToken);
    await tokenModel.save(conn, tokens);   // committed only if the whole transaction succeeds
    logger.info('Zalo access token refreshed');
    return tokens.accessToken;
  });
}

async function getAccessToken() {
  const row = await tokenModel.get(null);
  if (row && !row.needs_refresh) return row.access_token;
  return refresh();
}

/** Called after Zalo answered "invalid access token": force a refresh unless another worker already did. */
const forceRefresh = (rejectedToken) => refresh(rejectedToken);

module.exports = { getAccessToken, forceRefresh };
