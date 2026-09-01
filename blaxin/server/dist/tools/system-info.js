import { exec } from 'child_process';
import { promisify } from 'util';
import { hostname, platform, release, totalmem, freemem, cpus, uptime } from 'os';
const execAsync = promisify(exec);
export class SystemInfoTool {
    name = 'system-info';
    description = 'Get system information including OS details, memory, CPU, disk space, running processes, and network status.';
    definition = {
        type: 'function',
        function: {
            name: 'system-info',
            description: 'Get system information: OS, memory, CPU, disk, network, running processes.',
            parameters: {
                type: 'object',
                properties: {
                    info: {
                        type: 'string',
                        enum: ['general', 'memory', 'cpu', 'disk', 'network', 'processes', 'all'],
                        description: 'Type of system information to retrieve',
                    },
                },
                required: ['info'],
            },
        },
    };
    async execute(args) {
        const info = args.info;
        try {
            switch (info) {
                case 'general': {
                    return {
                        success: true,
                        output: [
                            `Hostname: ${hostname()}`,
                            `Platform: ${platform()}`,
                            `OS Release: ${release()}`,
                            `Uptime: ${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`,
                            `CPU: ${cpus()[0]?.model || 'Unknown'} (${cpus().length} cores)`,
                            `Total Memory: ${Math.round(totalmem() / 1024 / 1024 / 1024)}GB`,
                            `Free Memory: ${Math.round(freemem() / 1024 / 1024 / 1024)}GB`,
                        ].join('\n'),
                    };
                }
                case 'memory': {
                    const total = Math.round(totalmem() / 1024 / 1024);
                    const free = Math.round(freemem() / 1024 / 1024);
                    const used = total - free;
                    return {
                        success: true,
                        output: [
                            `Total: ${total}MB`,
                            `Used: ${used}MB (${Math.round(used / total * 100)}%)`,
                            `Free: ${free}MB (${Math.round(free / total * 100)}%)`,
                        ].join('\n'),
                    };
                }
                case 'cpu': {
                    const cpuInfo = cpus();
                    return {
                        success: true,
                        output: [
                            `Model: ${cpuInfo[0]?.model || 'Unknown'}`,
                            `Cores: ${cpuInfo.length}`,
                            `Speed: ${cpuInfo[0]?.speed || 'Unknown'}MHz`,
                        ].join('\n'),
                    };
                }
                case 'disk': {
                    try {
                        const { stdout } = await execAsync('df -h / 2>/dev/null || echo "df not available"', { timeout: 5000 });
                        return { success: true, output: stdout };
                    }
                    catch {
                        return { success: true, output: 'Disk info not available' };
                    }
                }
                case 'network': {
                    try {
                        const { stdout } = await execAsync('ip addr show 2>/dev/null || ifconfig 2>/dev/null || echo "Network info not available"', { timeout: 5000 });
                        // Only show non-loopback interfaces
                        const lines = stdout.split('\n').filter(l => !l.includes('loopback') && !l.includes('127.0.0'));
                        return { success: true, output: lines.join('\n').slice(0, 2000) };
                    }
                    catch {
                        return { success: true, output: 'Network info not available' };
                    }
                }
                case 'processes': {
                    try {
                        const { stdout } = await execAsync('ps aux --sort=-%mem | head -20', { timeout: 5000 });
                        return { success: true, output: stdout };
                    }
                    catch {
                        try {
                            const { stdout } = await execAsync('ps aux | head -20', { timeout: 5000 });
                            return { success: true, output: stdout };
                        }
                        catch {
                            return { success: true, output: 'Process listing not available' };
                        }
                    }
                }
                case 'all': {
                    const sections = [];
                    sections.push('=== GENERAL ===');
                    sections.push(`Hostname: ${hostname()}`);
                    sections.push(`Platform: ${platform()} ${release()}`);
                    sections.push(`Uptime: ${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`);
                    sections.push('\n=== CPU ===');
                    sections.push(`${cpus()[0]?.model || 'Unknown'} (${cpus().length} cores)`);
                    const total = Math.round(totalmem() / 1024 / 1024);
                    const free = Math.round(freemem() / 1024 / 1024);
                    sections.push('\n=== MEMORY ===');
                    sections.push(`Used: ${total - free}MB / ${total}MB (${Math.round((total - free) / total * 100)}%)`);
                    try {
                        const { stdout } = await execAsync('df -h / 2>/dev/null', { timeout: 3000 });
                        sections.push('\n=== DISK ===');
                        sections.push(stdout);
                    }
                    catch { }
                    return { success: true, output: sections.join('\n') };
                }
                default:
                    return { success: false, output: '', error: `Unknown info type: ${info}` };
            }
        }
        catch (error) {
            return { success: false, output: '', error: `System info error: ${error.message}` };
        }
    }
}
//# sourceMappingURL=system-info.js.map