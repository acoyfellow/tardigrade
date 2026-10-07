import { type ManagedResource, Runtime } from "foldkit";
import { Flags, flags, init } from "./main";
import { Message } from "./message";
import { Model } from "./model";
import { AgentClientLive } from "./rpc";
import { type AgentSocket, managedResources, subscriptions } from "./socket";
import type { AgentClient } from "./rpc";
import type { Flags as StartupFlags } from "./main";
import { update } from "./update";
import { view } from "./view";

const application = Runtime.makeApplication<Model, Message, StartupFlags, AgentClient, ManagedResource.ServiceOf<typeof AgentSocket>>({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	managedResources,
	resources: AgentClientLive,
	container: document.getElementById("root"),
	devTools: { Message },
});

Runtime.run(application, { flags });
