# Customer media (inbound photos and voice notes, logos, rendered posts): private, uniform access,
# public access prevented, versioned, with lifecycle rules. The ages are provisional until the human
# sets the media retention policy (technical-design.md, Still required).

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "force_destroy" { type = bool }
variable "noncurrent_days" {
  description = "Days a replaced or deleted object version is kept."
  type        = number
}
variable "coldline_after_days" { type = number }

resource "google_storage_bucket" "media" {
  project                     = var.project_id
  name                        = var.name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.noncurrent_days
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = var.coldline_after_days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  # Scratch files from rendering.
  lifecycle_rule {
    condition {
      age            = 1
      matches_prefix = ["tmp/"]
    }
    action {
      type = "Delete"
    }
  }
}

output "name" { value = google_storage_bucket.media.name }
