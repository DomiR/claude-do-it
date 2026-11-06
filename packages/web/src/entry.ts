import { Runtime } from 'foldkit';

import './styles.css';

import { flags, Flags, init, Message, Model } from './main';
import { DoItClientLive } from './rpc';
import { subscriptions } from './subscription';
import { update } from './update';
import { view } from './view';

const application = Runtime.makeApplication({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	resources: DoItClientLive,
	container: document.getElementById('root'),
	devTools: { Message }
});

Runtime.run(application, { flags });
