import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://api.github.com';
const REPOSITORY = 'devrev/sentinel';
const WORKFLOW_FILE = 'claude-code-review.yml';
const TITLE_PATTERN = /^POC Test: .+-DO NOT REVIEW$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function refuse(message: string): never {
	throw new Error(`Sentinel review dispatch refused: ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Thin CircleCI -> workflow_dispatch bridge: validates the trusted staging
// pipeline and live PR, then posts the exact dispatch body. Not review authority.
export async function dispatchSentinelReview(env: NodeJS.ProcessEnv, request: typeof fetch = fetch): Promise<void> {
	if (env.CIRCLECI !== 'true') refuse('must run under CircleCI');
	if (env.CIRCLE_BRANCH !== 'staging') refuse('must run on the staging branch');
	if (env.CIRCLE_PROJECT_USERNAME !== 'devrev' || env.CIRCLE_PROJECT_REPONAME !== 'sentinel') {
		refuse('unexpected CircleCI project');
	}
	const sha = env.CIRCLE_SHA1 ?? '';
	if (!SHA_PATTERN.test(sha)) refuse('CIRCLE_SHA1 must be a lowercase 40-char SHA');
	if (env.SENTINEL_REVIEW_DISPATCH_READY !== 'true') {
		refuse('operator has not enabled dispatch; external context restriction is unverified');
	}
	const prRaw = env.SENTINEL_REVIEW_PR ?? '';
	if (!/^[1-9][0-9]*$/.test(prRaw) || !Number.isSafeInteger(Number(prRaw)) || String(Number(prRaw)) !== prRaw) {
		refuse('SENTINEL_REVIEW_PR must be a canonical positive integer');
	}
	if (env.SENTINEL_REVIEW_POC_APPROVED_PR !== prRaw) refuse('requested PR is not the approved POC PR');
	const token = env.SENTINEL_REVIEW_DISPATCH_TOKEN ?? '';
	if (token.length === 0) refuse('dispatch credential missing');
	const pullRequest = Number(prRaw);

	const call = async (apiPath: string, init: RequestInit = {}): Promise<Response> => {
		try {
			return await request(`${API_ROOT}${apiPath}`, {
				...init,
				headers: {
					authorization: `Bearer ${token}`,
					accept: 'application/vnd.github+json',
					'x-github-api-version': '2022-11-28',
					...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
				},
				redirect: 'error',
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			refuse(`GitHub request to ${apiPath} failed; a timed-out POST may already have dispatched, check Actions before any manual retry`);
		}
	};
	const body = async (response: Response): Promise<Record<string, unknown>> => {
		const parsed: unknown = await response.json().catch((): never => refuse('non-JSON GitHub response'));
		if (!object(parsed)) refuse('unexpected GitHub response shape');
		return parsed;
	};

	const branchResponse = await call(`/repos/${REPOSITORY}/branches/staging`);
	if (branchResponse.status !== 200) refuse(`staging branch lookup failed (${branchResponse.status})`);
	const branch = await body(branchResponse);
	if (!object(branch.commit) || branch.commit.sha !== sha) refuse('pipeline SHA is stale against the staging head');

	const pullResponse = await call(`/repos/${REPOSITORY}/pulls/${String(pullRequest)}`);
	if (pullResponse.status !== 200) refuse(`pull request lookup failed (${pullResponse.status})`);
	const pull = await body(pullResponse);
	const base = pull.base;
	const head = pull.head;
	if (pull.number !== pullRequest || pull.state !== 'open') refuse('pull request is not open');
	if (!object(base) || base.ref !== 'staging' || base.sha !== sha) refuse('pull base is stale or not staging');
	if (!object(head) || typeof head.sha !== 'string' || !SHA_PATTERN.test(head.sha)) refuse('pull head SHA invalid');
	if (!object(head.repo) || head.repo.full_name !== REPOSITORY) refuse('pull head is a fork');
	if (typeof pull.title !== 'string' || !TITLE_PATTERN.test(pull.title)) refuse('PR title is not an approved POC test title');

	const dispatchResponse = await call(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
		method: 'POST',
		body: JSON.stringify({
			ref: 'staging',
			inputs: {
				mode: 'review',
				pr_number: String(pullRequest),
				base_sha: base.sha,
				head_sha: head.sha,
			},
		}),
	});
	if (dispatchResponse.status !== 204) {
		refuse(
			`workflow dispatch rejected (${dispatchResponse.status}); a timed-out POST may already have dispatched, check Actions before any manual retry`
		);
	}
	console.log(`dispatch requested for PR ${String(pullRequest)} base ${String(base.sha)} head ${String(head.sha)}`);
	console.log('dispatch accepted; not a review approval');
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
	dispatchSentinelReview(process.env).catch((error: unknown): void => {
		const message = error instanceof Error ? error.message : '';
		console.error(message.startsWith('Sentinel review dispatch refused:') ? message : 'Sentinel review dispatch refused: operational failure');
		process.exitCode = 1;
	});
}
