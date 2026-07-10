"use client";

import { createContext, useContext } from "react";

type LeftNav = { open: boolean; setOpen: (open: boolean) => void };

const LeftNavContext = createContext<LeftNav>({ open: false, setOpen: () => {} });

export const LeftNavProvider = LeftNavContext.Provider;

export function useLeftNav(): LeftNav {
  return useContext(LeftNavContext);
}
