# WbertoreCDK
Infrastructure as code project for infrastructure in personal aws account

## Pre-requisites
1. Install cdk: `brew install aws-cdk`
2. node: `brew install node`

## Building locally
Run the following command to build and format the project:
```bash
npm run build
```

Run the following command to verify the app synthesizes and spits out a cloudformation template
```
npm run cdk synthesize
```

## Regenerating your ssh key to push to github
Your ssh key may expire (probably if it hasn't been used in a year).

Docs here: https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent

**TL;DR**:

To regenerate your key run this command:
```bash
ssh-keygen -t ed25519 -C "me@wbertore.dev" 
```

You'll then be prompted what to name it - I usually go with:
```
~/.ssh/github<version>_id_ed25519
```

Then you'll be asked for a passphrase. You can generate a new one in MacOS passwords.

Once you have the key generated, store the passphrase in keychain:
```bash
ssh-add --apple-use-keychain ~/.ssh/github<version>_id_ed25519
```

Now update your `~/.ssh/config` file to point to the new ssh key:
```
Host github.com
  AddKeysToAgent yes
  UseKeychain yes
- IdentityFile ~/.ssh/github1_id_ed25519
+ IdentityFile ~/.ssh/github2_id_ed25519
```

Now go to [github.com](https://github.com/settings/keys) and login.

Click new SSH Key, and name it whatever you want such as laptop key <version>. Then paste the contents of the public key in the text box:
```bash
cat ~/.ssh/github<version>_id_ed25519.pub
ssh-ed25519 ...
```

Click Add SSH key.

To verify the key is working run the following command, and verify you see the following output:
```bash
ssh -T git@github.com
Hi wbertore! You've successfully authenticated...
```

## Getting aws cli credentials
I setup this aws account to use sso via identity center.

To login run the following command:
```
aws sso login --profile wbertore-admin
```

From there on you can run commands in the cli specifiying the profile
```
aws sts get-caller-identity --profile wbertore-admin
```

## Logging into the aws console
You can also use SSO to login to the aws account.
Navigate here: https://d-9267d93f90.awsapps.com/start/

## Troubleshooting

### CodePipeline not picking up GitHub changes
CodePipeline can sometimes take a few minutes to detect changes pushed to GitHub via CodeStar connection webhooks. If your pipeline hasn't triggered after pushing code, wait 5-10 minutes before investigating further.

If the delay persists, check:
- CodeStar connection status: `aws codestar-connections list-connections --profile wbertore-admin`
- Pipeline execution history: `aws codepipeline list-pipeline-executions --pipeline-name Pipeline --profile wbertore-admin`
- GitHub webhook delivery history in your repo settings (Settings → Webhooks)

You can also manually trigger the pipeline:
```bash
aws codepipeline start-pipeline-execution --name Pipeline --profile wbertore-admin
```