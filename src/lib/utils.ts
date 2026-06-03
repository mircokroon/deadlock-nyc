import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Image manifests store root-absolute paths ("/items/…"). Resolve them against
// Vite's base so they work both at the apex domain (deadlock.nyc/) and at a
// sub-path deploy (username.github.io/repo/), where "/items/…" would 404.
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, "");
}
