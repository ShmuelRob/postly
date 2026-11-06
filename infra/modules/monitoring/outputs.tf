# The on-call email channel, for alerts outside this module (the model budget in stack/models.tf).
output "email_channel_ids" {
  value = google_monitoring_notification_channel.email[*].id
}
