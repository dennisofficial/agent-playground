import type { CurrentUserResponse } from "@workspace/shared";
import { baseApi, EBaseApiCacheTags } from "./baseApi";

/**
 * Session read. Login / register / logout stay on the `@workspace/auth` singleton
 * (it owns cookie + auth-state lifecycle); this endpoint just surfaces the operator
 * identity + orgs (`GET /auth/session`) for the shell to render.
 */
export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getSession: build.query<CurrentUserResponse, void>({
      query: () => ({ url: "/auth/session", method: "GET" }),
      providesTags: [EBaseApiCacheTags.SESSION],
    }),
  }),
});

export const { useGetSessionQuery } = authApi;
