variable "ghcr_owner" {
  type = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.ghcr_owner))
    error_message = "ghcr_owner doit être en minuscules (lettres, chiffres, tirets)."
  }
}

variable "image_tag" {
  type    = string
  default = "latest"

  validation {
    condition     = can(regex("^([0-9a-f]{7}|latest)$", var.image_tag))
    error_message = "image_tag doit être un SHA court (7 caractères hexadécimaux) ou latest."
  }
}

variable "front_port" {
  type    = number
  default = 8081

  validation {
    condition     = var.front_port >= 1024 && var.front_port <= 65535
    error_message = "front_port doit être entre 1024 et 65535."
  }
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "db_password" {
  type      = string
  default   = null
  sensitive = true
}

variable "ghcr_username" {
  type    = string
  default = null
}

variable "ghcr_token" {
  type      = string
  default   = null
  sensitive = true
}
