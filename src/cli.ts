#!/usr/bin/env node
import { runCli } from './cli-functions.js';

runCli().then((code) => {
  if (code !== 0) {
    process.exitCode = code;
  }
});
