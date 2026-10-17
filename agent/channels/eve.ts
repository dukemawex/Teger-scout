import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Only the Teger Scout controller talks to this agent, over loopback, with a
// per-deployment secret. Browsers never reach the eve routes directly.
export default eveChannel({
  auth: [
    httpBasic({
      username: "teger-controller",
      password: process.env.EVE_INTERNAL_PASSWORD ?? "",
    }),
  ],
});
