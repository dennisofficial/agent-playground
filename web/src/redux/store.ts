import { baseApi } from '@/redux/query/api/baseApi';
import { isLiveSerializable } from '@dltech/pgbase/client';
import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query/react';

export const makeStore = () => {
  const store = configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
    },
    // Live pgbase rows keep their real Date/bigint types over the wire, which RTK's plain-JSON
    // default `serializableCheck` rejects — widen it to exactly those rather than disabling it.
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: { isSerializable: isLiveSerializable } }).concat(
        baseApi.middleware,
      ),
  });
  setupListeners(store.dispatch);
  return store;
};

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
