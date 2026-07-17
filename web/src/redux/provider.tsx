"use client";

import { makeStore, type AppStore } from "@/redux/store";
import { useRef, type FC, type PropsWithChildren } from "react";
import { Provider } from "react-redux";

export const ReduxProvider: FC<PropsWithChildren> = ({ children }) => {
  const storeRef = useRef<AppStore>(undefined);
  if (!storeRef.current) {
    storeRef.current = makeStore();
  }
  return <Provider store={storeRef.current}>{children}</Provider>;
};
