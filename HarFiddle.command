#!/bin/bash
# Double-click in Finder to start HarFiddle (opens the UI in your browser).
cd "$(dirname "$0")" && exec node server.js "$@"
