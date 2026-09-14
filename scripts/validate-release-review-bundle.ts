import { runValidateReleaseReviewCommand } from './release-review-cli.js'

process.exitCode = await runValidateReleaseReviewCommand(process.argv.slice(2))
