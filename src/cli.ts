#!/usr/bin/env node
import { runCli } from './cli-functions';

runCli().then((code) => {
  if (code !== 0) {
    process.exitCode = code;
  }
});
