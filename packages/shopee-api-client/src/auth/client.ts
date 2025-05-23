// TODO: https://claude.ai/chat/c64f103a-1d7b-4d32-8d71-51deeb083594

import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { ShopeeAPIConfig } from "../config";
import { ShopeeTokenStorage } from "../token-storage";
import { generateSignature, getCurrentTimestamp } from "../utils";
import { GetAccessTokenResponse, RefreshAccessTokenResponse } from "./schema";

// Token-related errors
export class TokenExpiredError extends Error {
  readonly _tag = "TokenExpiredError";
  constructor(public readonly shopId: number) {
    super(`Token expired for shop ID: ${shopId}`);
  }
}

export class TokenNotFoundError extends Error {
  readonly _tag = "TokenNotFoundError";
  constructor(public readonly shopId: number) {
    super(`Token not found for shop ID: ${shopId}`);
  }
}

const makeShopeeAuthClient = Effect.gen(function* () {
  const defaultClient = yield* HttpClient.HttpClient;
  const config = yield* ShopeeAPIConfig;
  const tokenStorage = yield* ShopeeTokenStorage;

  const { apiBaseUrl, partnerId, partnerKey } = yield* config.getConfig;

  const baseClient = defaultClient.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(apiBaseUrl)),
  );

  const prepareSearchParams = (apiPath: string) => {
    const timestamp = getCurrentTimestamp();
    const baseString = `${partnerId}${apiPath}${timestamp}`;
    const signature = generateSignature(partnerKey, baseString);

    const searchParams = new URLSearchParams();
    searchParams.append("partner_id", partnerId.toString());
    searchParams.append("timestamp", timestamp.toString());
    searchParams.append("sign", signature);

    return searchParams;
  };

  const prepareRequest = (apiPath: string) => {
    const searchParams = prepareSearchParams(apiPath);
    return baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(HttpClientRequest.appendUrlParams(searchParams)),
      ),
    );
  };

  // Helper to check if token is expired (with 5-minute buffer)
  const isTokenExpired = (token: { expiresAt: Date }): boolean => {
    const now = new Date();
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    return token.expiresAt.getTime() - bufferTime <= now.getTime();
  };

  // Internal refresh logic
  const performTokenRefresh = (refreshToken: string, shopId: number) => {
    const apiPath = "/api/v2/auth/access_token/get";

    return Effect.gen(function* () {
      const client = prepareRequest(apiPath);

      const req = yield* HttpClientRequest.post(apiPath).pipe(
        HttpClientRequest.setHeaders({
          "Content-Type": "application/json",
        }),
        HttpClientRequest.bodyJson({
          shop_id: shopId,
          partner_id: partnerId,
          refresh_token: refreshToken,
        }),
      );

      const response = yield* client.execute(req);

      const tokenResponse = yield* HttpClientResponse.schemaBodyJson(
        RefreshAccessTokenResponse,
      )(response);

      yield* tokenStorage.storeToken(shopId, {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresIn: tokenResponse.expire_in,
      });

      return tokenResponse;
    }).pipe(Effect.scoped);
  };

  return {
    /**
     * @see https://open.shopee.com/developer-guide/20
     */
    getAuthUrl: (redirectUrl: string) => {
      const apiPath = "/api/v2/shop/auth_partner";
      const searchParams = prepareSearchParams(apiPath);
      searchParams.append("redirect", redirectUrl);

      const url = new URL(`${apiBaseUrl}${apiPath}`);
      searchParams.forEach((value, key) => {
        url.searchParams.append(key, value);
      });

      return url.toString();
    },

    /**
     * @see https://open.shopee.com/documents/v2/v2.public.get_access_token?module=104&type=1
     */
    getAccessToken: (code: string, shopId: number) => {
      const apiPath = "/api/v2/auth/token/get";

      return Effect.gen(function* () {
        const client = prepareRequest(apiPath);

        const req = yield* HttpClientRequest.post(apiPath).pipe(
          HttpClientRequest.setHeaders({
            "Content-Type": "application/json",
          }),
          HttpClientRequest.bodyJson({
            shop_id: shopId,
            partner_id: partnerId,
            code,
          }),
        );

        const response = yield* client.execute(req);

        // TODO: Error path
        // raw response {
        //   error: 'error_auth',
        //   message: 'Invalid code',
        //   request_id: 'e3e3e7f335c430e774f7c9cc61e99601'
        // }

        const tokenResponse = yield* HttpClientResponse.schemaBodyJson(
          GetAccessTokenResponse,
        )(response);

        yield* tokenStorage.storeToken(shopId, {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          expiresIn: tokenResponse.expire_in,
        });

        // TODO: Handle invalid code response explicitly
        return tokenResponse;
      }).pipe(Effect.scoped);
    },

    /**
     * @see https://open.shopee.com/documents/v2/v2.public.refresh_access_token?module=104&type=1
     */
    refreshAccessToken: (refreshToken: string, shopId: number) => {
      return performTokenRefresh(refreshToken, shopId);
    },

    /**
     * Get a valid access token for the shop, automatically refreshing if needed
     * This is the main method API clients should use
     */
    getValidAccessToken: (shopId: number) =>
      Effect.gen(function* () {
        // Try to get existing token
        const token = yield* tokenStorage.getToken(shopId);

        // If token is not expired, return it
        if (!isTokenExpired(token)) {
          return token.accessToken;
        }

        yield* performTokenRefresh(token.refreshToken, shopId);

        // Get the refreshed token
        const refreshedToken = yield* tokenStorage.getToken(shopId);
        return refreshedToken.accessToken;
      }),

    /**
     * Clear tokens for a shop (useful for logout/revoke)
     */
    clearTokens: (shopId: number) => tokenStorage.clearToken(shopId),
  };
});

export class ShopeeAuthClient extends Context.Tag("ShopeeAuthClient")<
  ShopeeAuthClient,
  Effect.Effect.Success<typeof makeShopeeAuthClient>
>() {
  static readonly Live = Layer.effect(
    ShopeeAuthClient,
    makeShopeeAuthClient,
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
