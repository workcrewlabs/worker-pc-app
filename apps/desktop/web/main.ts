// Entry shim: the real entry lives in the shared renderer source tree, outside
// this vite root. An HTML script src cannot reference outside the root in dev,
// but a module import can (via server.fs.allow), so this one-line module is
// what index.html loads.
import "../src/renderer/src/main-web";
