export interface DiagnosticCheck {
    name: string;
    status: 'ok' | 'warning' | 'error' | 'unknown';
    message: string;
    details?: string;
    suggestion?: string;
}
export interface DiagnosticGroup {
    name: string;
    icon: string;
    checks: DiagnosticCheck[];
}
export interface DiagnosticsResult {
    overall: 'ok' | 'warning' | 'error';
    groups: DiagnosticGroup[];
    timestamp: number;
}
export declare function runDiagnostics(): Promise<DiagnosticsResult>;
//# sourceMappingURL=diagnostics.d.ts.map