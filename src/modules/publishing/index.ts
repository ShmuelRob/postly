// Publishing: connects channels, publishes, and checks status.
// Public surface of the module: other code imports only from this file (see ../README.md).

export { holidayInWeek } from './jewish-calendar.js';
export { createChannels, type ApplyChannelEvent, type Channels, type ChannelStatus } from './channels.js';
export { createScheduling, MissingChannelError, type ApplyPostEvent, type Scheduling } from './scheduling.js';
export { createPublishingJob, MAX_ATTEMPTS, RETRY_DELAYS_MS, STALE_MS, type ApplyPublishingEvent, type Publishing, type PublishingJobDeps, type PublishingNotice } from './job.js';
export { noPublishingWindows, NoTimeAvailableError, proposeTimes, type ScheduleRules } from './times.js';
export { createMonthlyReport, previousMonth, type MonthlyFigures, type MonthlyReport } from './report.js';
