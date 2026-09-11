/**
 * Compile-time app metadata, injected by vite.config `define`. Kept in a
 * module (not used inline in SFC templates) because vue-tsc resolves
 * template identifiers against the component instance, not ambient globals.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;
