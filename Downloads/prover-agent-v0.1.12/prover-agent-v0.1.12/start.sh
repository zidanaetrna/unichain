#!/bin/bash

AGENT_HOST=0.0.0.0:14000
NOTIFY_HOST=notify.47s3rx.org:38883

./prover-agent -l $AGENT_HOST -notify $NOTIFY_HOST > agent.log 2>&1 &

