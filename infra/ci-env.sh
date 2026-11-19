#!/usr/bin/env bash
# Prépare les TF_VAR_* d'un job GitHub Actions, depuis infra/ après tofu init.
# Usage : ./ci-env.sh [tag]   (sans tag : garde la version déjà déployée)
set -euo pipefail

: "${GITHUB_ENV:?à lancer dans un job GitHub Actions}"
: "${GITHUB_REPOSITORY_OWNER:?variable GitHub absente}"

tag="${1:-}"
if [ -z "$tag" ]; then
  # Pas de state (premier déploiement) : tofu output échoue -> latest
  tag="$(tofu output -raw image_tag 2>/dev/null || true)"
  tag="${tag:-latest}"
fi
if [[ ! "$tag" =~ ^([0-9a-f]{7}|latest)$ ]]; then
  echo "::error::Tag invalide : '$tag'" >&2
  exit 1
fi

{
  echo "TF_VAR_ghcr_owner=${GITHUB_REPOSITORY_OWNER,,}"
  echo "TF_VAR_image_tag=$tag"
} >> "$GITHUB_ENV"

env_file="${STAGING_DIR:-}/.env"
if [ -n "${STAGING_DIR:-}" ] && [ -f "$env_file" ]; then
  password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1)"
  if [ -n "$password" ]; then
    echo "::add-mask::$password"
    echo "TF_VAR_db_password=$password" >> "$GITHUB_ENV"
  fi
fi

echo "Variables OpenTofu prêtes : owner=${GITHUB_REPOSITORY_OWNER,,}, image_tag=$tag"
