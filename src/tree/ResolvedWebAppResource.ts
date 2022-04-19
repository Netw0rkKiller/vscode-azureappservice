/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AppServicePlan, Site, SiteConfig, SiteLogsConfig, SiteSourceControl } from '@azure/arm-appservice';
import { AppSettingsTreeItem, AppSettingTreeItem, deleteSite, DeploymentsTreeItem, DeploymentTreeItem, FolderTreeItem, LogFilesTreeItem, ParsedSite, SiteFilesTreeItem } from '@microsoft/vscode-azext-azureappservice';
import { AzExtTreeItem, IActionContext, ISubscriptionContext, nonNullProp, TreeItemIconPath } from '@microsoft/vscode-azext-utils';
import { ResolvedAppResourceBase } from '../api';
import { nonNullValue } from '../utils/nonNull';
import { openUrl } from '../utils/openUrl';
import { getIconPath, getThemedIconPath } from '../utils/pathUtils';
import { CosmosDBConnection } from './CosmosDBConnection';
import { CosmosDBTreeItem } from './CosmosDBTreeItem';
import { DeploymentSlotsNATreeItem, DeploymentSlotsTreeItem } from './DeploymentSlotsTreeItem';
import { ISiteTreeItem } from './ISiteTreeItem';
import { NotAvailableTreeItem } from './NotAvailableTreeItem';
import { SiteTreeItem } from './SiteTreeItem';
import { WebJobsNATreeItem, WebJobsTreeItem } from './WebJobsTreeItem';

export class ResolvedWebAppResource implements ResolvedAppResourceBase, ISiteTreeItem {
    public site: ParsedSite;

    public contextValuesToAdd?: string[] | undefined;
    public maskedValuesToAdd: string[] = [];

    public static webAppContextValue: string = 'azAppWebApp';
    public static slotContextValue: string = 'azAppSlot';

    commandId?: string | undefined;
    tooltip?: string | undefined;
    commandArgs?: unknown[] | undefined;

    public deploymentSlotsNode: DeploymentSlotsTreeItem | DeploymentSlotsNATreeItem | undefined;
    public deploymentsNode: DeploymentsTreeItem | undefined;
    public appSettingsNode!: AppSettingsTreeItem;
    private _connectionsNode!: CosmosDBTreeItem;
    private _siteFilesNode!: SiteFilesTreeItem;
    private _logFilesNode!: LogFilesTreeItem;
    private _webJobsNode!: WebJobsTreeItem | WebJobsNATreeItem;

    private _subscription: ISubscriptionContext;

    constructor(subscription: ISubscriptionContext, site: Site) {
        this.site = new ParsedSite(site, subscription);
        this._subscription = subscription;
        this.contextValuesToAdd = [this.site.isSlot ? ResolvedWebAppResource.slotContextValue : ResolvedWebAppResource.webAppContextValue];

        const valuesToMask = [
            this.site.siteName, this.site.slotName, this.site.defaultHostName, this.site.resourceGroup,
            this.site.planName, this.site.planResourceGroup, this.site.kuduHostName, this.site.gitUrl,
            this.site.rawSite.repositorySiteName, ...(this.site.rawSite.hostNames || []), ...(this.site.rawSite.enabledHostNames || [])
        ];

        for (const v of valuesToMask) {
            if (v) {
                this.maskedValuesToAdd.push(v);
            }
        }
    }

    public get defaultHostUrl(): string {
        return this.site.defaultHostUrl;
    }

    public get defaultHostName(): string {
        return this.site.defaultHostName;
    }

    public async browse(): Promise<void> {
        await openUrl(this.site.defaultHostUrl);
    }

    public get description(): string | undefined {
        return this._state?.toLowerCase() !== 'running' ? this._state : undefined;
    }

    public get logStreamLabel(): string {
        return this.site.fullName;
    }

    public async refreshImpl(context: IActionContext): Promise<void> {
        const client = await this.site.createClient(context);
        this.site = new ParsedSite(nonNullValue(await client.getSite(), 'site'), this._subscription);
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    public get id(): string {
        return this.site.id;
    }

    public get label(): string {
        return this.site.slotName ?? this.site.siteName;
    }

    public get name(): string {
        return this.label;
    }

    private get _state(): string | undefined {
        return this.site.rawSite.state;
    }

    public get iconPath(): TreeItemIconPath {
        return this.site.isSlot ? getThemedIconPath('DeploymentSlot_color') : getIconPath('WebApp');
    }

    public async loadMoreChildrenImpl(_clearCache: boolean, context: IActionContext): Promise<AzExtTreeItem[]> {
        const proxyTree: SiteTreeItem = this as unknown as SiteTreeItem;

        this.appSettingsNode = new AppSettingsTreeItem(proxyTree, this.site);
        this._connectionsNode = new CosmosDBTreeItem(proxyTree, this.site);
        this._siteFilesNode = new SiteFilesTreeItem(proxyTree, this.site, false);
        this._logFilesNode = new LogFilesTreeItem(proxyTree, this.site);
        // Can't find actual documentation on this, but the portal claims it and this feedback suggests it's not planned https://aka.ms/AA4q5gi
        this._webJobsNode = this.site.isLinux ? new WebJobsNATreeItem(proxyTree) : new WebJobsTreeItem(proxyTree);

        const client = await this.site.createClient(context);
        const siteConfig: SiteConfig = await client.getSiteConfig();
        const sourceControl: SiteSourceControl = await client.getSourceControl();
        this.deploymentsNode = new DeploymentsTreeItem(proxyTree, this.site, siteConfig, sourceControl);

        const children: AzExtTreeItem[] = [this.appSettingsNode, this._connectionsNode, this.deploymentsNode, this._siteFilesNode, this._logFilesNode, this._webJobsNode];

        if (!this.site.isSlot) {
            let tier: string | undefined;
            let asp: AppServicePlan | undefined;
            try {
                const client = await this.site.createClient(context);
                asp = await client.getAppServicePlan();
                tier = asp && asp.sku && asp.sku.tier;
            } catch (err) {
                // ignore this error, we don't want to block users for deployment slots
                tier = 'unknown';
            }

            this.deploymentSlotsNode = tier && /^(basic|free|shared)$/i.test(tier) ? new DeploymentSlotsNATreeItem(proxyTree, nonNullProp(nonNullValue(asp), 'id')) : new DeploymentSlotsTreeItem(proxyTree);
            children.push(this.deploymentSlotsNode);
        }

        return children;
    }

    public compareChildrenImpl(ti1: AzExtTreeItem, ti2: AzExtTreeItem): number {
        if (ti1 instanceof NotAvailableTreeItem) {
            return 1;
        } else if (ti2 instanceof NotAvailableTreeItem) {
            return -1;
        } else {
            return ti1.label.localeCompare(ti2.label);
        }
    }

    public pickTreeItemImpl(expectedContextValues: (string | RegExp)[]): AzExtTreeItem | undefined {
        if (!this.site.isSlot) {
            for (const expectedContextValue of expectedContextValues) {
                switch (expectedContextValue) {
                    case DeploymentSlotsTreeItem.contextValue:
                    case ResolvedWebAppResource.slotContextValue:
                        return this.deploymentSlotsNode;
                    default:
                }
            }
        }

        for (const expectedContextValue of expectedContextValues) {
            switch (expectedContextValue) {
                case AppSettingsTreeItem.contextValue:
                case AppSettingTreeItem.contextValue:
                    return this.appSettingsNode;
                case CosmosDBTreeItem.contextValueInstalled:
                case CosmosDBTreeItem.contextValueNotInstalled:
                case CosmosDBConnection.contextValue:
                    return this._connectionsNode;
                case DeploymentsTreeItem.contextValueConnected:
                case DeploymentsTreeItem.contextValueUnconnected:
                case DeploymentTreeItem.contextValue:
                    return this.deploymentsNode;
                case FolderTreeItem.contextValue:
                    return this._siteFilesNode;
                case WebJobsTreeItem.contextValue:
                    return this._webJobsNode;
                default:
                    if (typeof expectedContextValue === 'string' && DeploymentTreeItem.contextValue.test(expectedContextValue)) {
                        return this.deploymentsNode;
                    }
            }
        }

        return undefined;
    }

    public async deleteTreeItemImpl(context: IActionContext): Promise<void> {
        await deleteSite(context, this.site);
    }

    public async isHttpLogsEnabled(context: IActionContext): Promise<boolean> {
        const client = await this.site.createClient(context);
        const logsConfig: SiteLogsConfig = await client.getLogsConfig();
        return !!(logsConfig.httpLogs && logsConfig.httpLogs.fileSystem && logsConfig.httpLogs.fileSystem.enabled);
    }

    public async enableLogs(context: IActionContext): Promise<void> {
        const logsConfig: SiteLogsConfig = {};
        if (!this.site.isLinux) {
            logsConfig.applicationLogs = {
                fileSystem: {
                    level: 'Verbose'
                }
            };
        }
        logsConfig.httpLogs = {
            fileSystem: {
                enabled: true,
                retentionInDays: 7,
                retentionInMb: 100
            }
        };
        const client = await this.site.createClient(context);
        await client.updateLogsConfig(logsConfig);
    }
}
