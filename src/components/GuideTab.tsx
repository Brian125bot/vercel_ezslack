import { BookOpen } from 'lucide-react';
import { ServerStatus } from '../types.js';

interface GuideTabProps {
  status: ServerStatus | null;
}

export function GuideTab({ status }: GuideTabProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col gap-5 transition-all">
      <div>
        <div className="flex items-center gap-2">
          <span className="p-1 bg-slate-100 text-slate-700 rounded">
            <BookOpen className="w-5 h-5" />
          </span>
          <h2 className="text-lg font-bold text-slate-900">Cloud Run Integration Instruction Guide</h2>
        </div>
        <p className="text-xs text-slate-500 mt-1">
          Follow these step-by-step blueprint instructions to connect this serverless stack live with your Slack Workspace.
        </p>
      </div>

      <div className="space-y-4 text-sm text-slate-700">
        <div className="flex gap-3">
          <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">1</div>
          <div className="flex-1">
            <h4 className="font-semibold text-slate-900">Option A: Create with Slack App Manifest (Fastest!)</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Navigate to the <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-indigo-600 font-medium hover:underline">Slack App Console</a>, select <strong>Create New App</strong>, choose <strong>App Manifest</strong>, select your target workspace, and paste the pre-configured JSON configuration block below:
            </p>
            
            <div className="mt-3 bg-slate-905 bg-slate-900 text-slate-200 rounded-xl p-3 border border-slate-800 font-mono text-[11px] relative">
              <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
                <span className="text-slate-400 font-sans text-[10px] font-bold">slack-manifest.json</span>
                <button 
                  onClick={() => {
                    const manifestText = JSON.stringify({
                      "_metadata": {
                        "major_version": 1,
                        "minor_version": 1
                      },
                      "display_information": {
                        "name": "Gemini AI Agent",
                        "description": "Production-ready serverless AI Agent",
                        "background_color": "#0d1117"
                      },
                      "features": {
                        "app_home": {
                          "home_tab_enabled": false,
                          "messages_tab_enabled": true,
                          "messages_tab_read_only_enabled": false
                        },
                        "bot_user": {
                          "display_name": "Gemini Agent",
                          "always_online": true
                        }
                      },
                      "oauth_config": {
                        "scopes": {
                          "bot": [
                            "app_mention",
                            "channels:history",
                            "groups:history",
                            "im:history",
                            "chat:write"
                          ]
                        }
                      },
                      "settings": {
                        "event_subscriptions": {
                          "request_url": `${status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events`,
                          "bot_events": [
                            "app_mention",
                            "message.channels",
                            "message.groups",
                            "message.im"
                          ]
                        },
                        "org_deploy_enabled": false,
                        "socket_mode_enabled": false,
                        "token_rotation_enabled": false
                      }
                    }, null, 2);
                    navigator.clipboard.writeText(manifestText);
                    alert("Copied Slack manifest to clipboard!");
                  }}
                  className="px-2 py-0.5 bg-slate-800 text-slate-300 hover:text-white rounded text-[10px] hover:bg-slate-700 transition"
                  id="btn-copy-manifest-clip"
                >
                  Copy JSON
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre font-light select-all max-h-48 text-[10px]">
{`{
  "_metadata": {
    "major_version": 1,
    "minor_version": 1
  },
  "display_information": {
    "name": "Gemini AI Agent",
    "description": "Production-ready serverless AI Agent",
    "background_color": "#0d1117"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Gemini Agent",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mention",
        "channels:history",
        "groups:history",
        "im:history",
        "chat:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "${status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events",
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}`}
              </pre>
            </div>

            <h4 className="font-semibold text-slate-900 mt-4 pt-4 border-t border-slate-100">Option B: Create manual app from scratch</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Select <strong>From scratch</strong> in the Slack Dashboard. Provide an app name, bind it to your target workspace, and continue with manual step configuration below.
            </p>
          </div>
        </div>

        <div className="flex gap-3 border-t border-slate-100 pt-4">
          <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">2</div>
          <div>
            <h4 className="font-semibold text-slate-900">Register Secrets in Google Cloud Run / AI Studio</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Retrieve credentials from your Slack Dashboard:
            </p>
            <ul className="list-disc list-inside text-xs text-slate-600 mt-1.5 space-y-1">
              <li>Use <strong className="text-slate-800">Signing Secret</strong> (found under Basic Information) as <code className="font-mono bg-slate-50 px-1 rounded">SLACK_SIGNING_SECRET</code>.</li>
              <li>Use <strong className="text-slate-800">Bot User OAuth Token</strong> (OAuth & Permissions) as <code className="font-mono bg-slate-50 px-1 rounded">SLACK_BOT_TOKEN</code>.</li>
            </ul>
            <p className="text-xs text-slate-400 mt-1.5">
              Click the "Settings" button inside the AI Studio bar, open the **Secrets** manager panel, and save these values right away.
            </p>
          </div>
        </div>

        <div className="flex gap-3 border-t border-slate-100 pt-4">
          <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">3</div>
          <div>
            <h4 className="font-semibold text-slate-900">Enable Webhook Event Subscriptions</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Inside your Slack developer dashboard, click "Event Subscriptions" and slide the toggle to "Enable Events". Under the URL input, paste your application's public URL appended with the precise events path:
            </p>
            <div className="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-xs my-2 select-all break-all border border-slate-700">
              {status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events
            </div>
            <p className="text-xs text-slate-500">
              Slack issues an instantaneous challenge POST request to verify the route. Thanks to our challenge-response interceptor, your backend handles this verification instantly and resolves green!
            </p>
          </div>
        </div>

        <div className="flex gap-3 border-t border-slate-100 pt-4">
          <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">4</div>
          <div>
            <h4 className="font-semibold text-slate-900">Subscribe Context & Install Bot</h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Under "Subscribe to bot events", subscribe to:
            </p>
            <div className="flex flex-wrap gap-1 mt-1.5">
              <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.channels</span>
              <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.groups</span>
              <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.im</span>
              <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">app_mention</span>
            </div>
            <p className="text-xs text-slate-500 mt-2">
               Click "Install to Workspace", authorize the agent, and invite the bot to any target Slack channels using <code className="font-mono bg-slate-100 text-slate-800 px-1 py-0.5 rounded">/invite @YourBotName</code>. Now type anything to receive response threads generated using Gemini-2.5-Flash!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
