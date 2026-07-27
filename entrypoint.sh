#!/bin/sh
# Ensure latest version of opencode is always installed
opencode upgrade
exec "$@"
