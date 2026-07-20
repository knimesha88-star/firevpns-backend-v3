const fs = require('fs');

let content = fs.readFileSync('backend/src/api/services/xuiService.ts', 'utf-8');

const replacement = `
          let streamSettings: any = {};
          try {
             if (inbound.streamSettings) {
                streamSettings = JSON.parse(inbound.streamSettings);
             }
          } catch(e) {}

          const config = await getXuiConfig();
          const baseUrl = getBaseUrl(config.panelUrl);

          return {
            email: c.email,
            uuid: c.id,
            inboundId: inbound.id,
            remark: inbound.remark,
            upload: up,
            download: down,
            totalTraffic: total,
            remainingTraffic: remaining,
            expiryTime: c.expiryTime || 0,
            enableStatus: c.enable,
            onlineStatus: c.enable && remaining >= 0, // simple heuristic
            subId: c.subId || '',
            port: inbound.port,
            protocol: inbound.protocol,
            network: streamSettings.network || 'tcp',
            security: streamSettings.security || 'none',
            serverAddress: baseUrl.replace(/^https?:\\/\\//, '').split(':')[0],
            serverName: inbound.remark
          };
`;

const regex = /return\s*{\s*email:\s*c\.email,\s*uuid:\s*c\.id,[\s\S]*?subId:\s*c\.subId\s*\|\|\s*''\s*};\s*}/m;

content = content.replace(regex, replacement.trim() + '\n        }');

fs.writeFileSync('backend/src/api/services/xuiService.ts', content);
console.log('Patched');
