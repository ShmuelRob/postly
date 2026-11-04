// Publishing: connects channels, publishes, and checks status.
// Public surface of the module: other code imports only from this file (see ../README.md).

export { createChannels, type ApplyChannelEvent, type Channels, type ChannelStatus } from './channels.js';
export { createScheduling, type Scheduling } from './scheduling.js';
