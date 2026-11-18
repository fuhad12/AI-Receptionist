// Bundles the official Vapi browser SDK into public/vapi-web.js so the demo page
// has no third-party CDN dependency. Rebuild with: npm run build:web
import Vapi from "@vapi-ai/web";
window.Vapi = Vapi.default ?? Vapi;
