// Stand-in for next/navigation in the demo build: the route lives in memory (the demo is one page).
import { useSyncExternalStore } from "react";

let path = "/explore";
const subs = new Set();
const set = (p) => { path = p.split("?")[0] || "/explore"; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };

export function usePathname() { return useSyncExternalStore(subscribe, () => path, () => path); }
export function useRouter() { return ROUTER; }
const ROUTER = { push: set, replace: set, back: () => set("/explore"), prefetch: () => {}, refresh: () => {} };
globalThis.__rendrrNav = { go: set, path: () => path }; // lets test scripts open any screen
