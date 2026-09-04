import { runValidateCommand } from './release-evidence-cli.js'

process.exitCode = await runValidateCommand(process.argv.slice(2))
