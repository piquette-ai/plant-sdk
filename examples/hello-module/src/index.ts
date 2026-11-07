// The Worker entrypoint. The plant's router reaches it only over a service
// binding; there are no public routes on the Worker itself.
import { moduleEntrypoint } from "@piquette/plant-sdk";
import { hello } from "./module.js";

export default moduleEntrypoint(hello);
