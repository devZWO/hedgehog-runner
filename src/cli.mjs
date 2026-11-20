#!/usr/bin/env node
import { runCli } from './runner.mjs';

process.exitCode = await runCli();
