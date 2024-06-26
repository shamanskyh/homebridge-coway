import {API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {AccessToken, CowayService} from "./coway";
import {CowayConfig} from "./interfaces/config";
import {Accessory, AccessoryInterface} from "./accessories/accessory";
import {Constants, DeviceType, SpecificDeviceType, IoCareEndpoint} from "./enumerations";
import {AirmegaAirPurifier} from "./accessories/air-purifiers/airmega-air-purifier";
import {MarvelAirPurifier} from "./accessories/air-purifiers/marvel-air-purifier";
import {DriverWaterPurifier} from "./accessories/water-purifiers/driver-water-purifier";
import {Device} from "./interfaces/device";
import compareSemanticVersion from "semver-compare";
import { access } from "fs";

type AccessoryTypes = 
    typeof DriverWaterPurifier |
    typeof MarvelAirPurifier |
    typeof AirmegaAirPurifier;

export class CowayPlatform implements DynamicPlatformPlugin {

    private readonly service: CowayService;
    private readonly config?: CowayConfig;
    private readonly accessories: Accessory<AccessoryInterface>[] = [];
    private readonly accessoryRegistry: { [deviceType in SpecificDeviceType]: AccessoryTypes } = {
        [SpecificDeviceType.DRIVER_WATER_PURIFIER]: DriverWaterPurifier,
        [SpecificDeviceType.MARVEL_AIR_PURIFIER]: MarvelAirPurifier,
        [SpecificDeviceType.AIRMEGA_AIR_PURIFIER]: AirmegaAirPurifier,
    };


    private accessToken?: AccessToken = undefined;

    constructor(private readonly log: Logging,
                config: PlatformConfig,
                private readonly api: API) {

        this.service = new CowayService(this.log);
        this.config = this.parseCowayConfig(config);

        if(!this.config) {
            this.log.warn("The coway config is not yet configured.");
            return;
        }
        const hapVersion = api.hap.HAPLibraryVersion();
        if(compareSemanticVersion(hapVersion, "0.10.3") < 0) {
            this.log.error("The HAP-NodeJS prerequisite version is 0.10.3. Currently on " + hapVersion);
            return;
        }

        api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            this.accessToken = await this.service.signIn(this.config);

            const success = await this.configureCowayDevices();
            if(success) {
                await this.refreshDevicesParallel();
                this.enqueueDeviceRefreshInterval();
            } else {
                // Enqueue shutting down in 30 seconds
                this.log.warn("It seems something went wrong with Coway services. Restarting in 30 seconds.");
                setTimeout(() => {
                    process.exit(1);
                }, 1000 * 30);
            }
        });
    }

    enqueueDeviceRefreshInterval() {
        setInterval(async () => {
            await this.refreshDevicesParallel();
        }, 30 * 1000);
    }

    async refreshDevicesParallel() {
        const queues = [];
        for(const accessory of this.accessories) {
            for(const endpoint of accessory.getEndpoints()) {
                queues.push(accessory.retrieveDeviceState(endpoint));
            }
        }
        const responses = await Promise.all(queues);
        for(const accessory of this.accessories) {
            const awaits = responses.splice(0, accessory.getEndpoints().length);
            await accessory.refresh(accessory.zipEndpointResponses(awaits));
        }
    }

    parseCowayConfig(config: PlatformConfig): CowayConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined || !value) {
                return undefined;
            }
        }
        return config as any as CowayConfig;
    }

    configureAccessory(platformAccessory: PlatformAccessory) {
        const context = platformAccessory.context as AccessoryInterface;
        if (!context.deviceInfo) {
            this.log.warn("Failed to reconfigure %s", platformAccessory.displayName);
            return;
        }
        const accessoryTypeString = context.deviceType + "+" + context.deviceInfo.prodName;
        const accessoryType = this.accessoryRegistry[<SpecificDeviceType>accessoryTypeString];
        if(!accessoryType) {
            this.log.warn("Failed to reconfigure %s", platformAccessory.displayName);
            return;
        }
        const accessory = new accessoryType(this.log, this.api, context.deviceInfo, this.service, platformAccessory);
        this.accessories.push(accessory);

        platformAccessory.context.configured = false;
        this.log.info("Configuring cached accessory: %s", platformAccessory.displayName);
        this.api.updatePlatformAccessories([platformAccessory]);
    }

    async checkAndRefreshDevicesOnline(devices: Device[]) {
        const response = await this.service.executeIoCareGetPayload(IoCareEndpoint.GET_DEVICE_CONNECTIONS, {
            devIds: devices.map((e) => e.barcode).join(','),
        }, this.accessToken);
        for(const info of response.data) {
            devices.filter((e) => e.barcode === info['devId'])
                .forEach((e) => {
                    e.netStatus = info['netStatus'];
                });
        }
    }

    async configureCowayDevices(): Promise<boolean> {
        // retrieve total 100 accessories in once
        const response = await this.service.executeIoCareGetPayload(IoCareEndpoint.GET_USER_DEVICES, {
            pageIndex: '0',
            pageSize: '100',
        }, this.accessToken).catch((error) => {
            return error.response;
        });
        if(!response.data?.deviceInfos) {
            this.log.error('Coway service is offline.');
            return false;
        }
        const deviceInfos: any[] = response.data.deviceInfos;

        if(!deviceInfos.length) {
            this.log.warn("No Coway devices in your account");
            return false;
        }

        const devices: Device[] = deviceInfos.map((e) => e as Device);
        await this.checkAndRefreshDevicesOnline(devices);
        for(const device of devices) {
            await this.addAccessory(device);
        }

        const accessoriesToRemove = [];
        for(let i = 0; i < this.accessories.length; i++) {
            const accessory = this.accessories[i];
            const platformAccessory = accessory.getPlatformAccessory();
            if(!platformAccessory.context.configured) {
                accessoriesToRemove.push(accessory);
            }
        }
        if(accessoriesToRemove.length) {
            accessoriesToRemove.forEach(accessory => {
                this.log.info('Removing accessory:', accessory.getPlatformAccessory().displayName);
                this.accessories.splice(this.accessories.indexOf(accessory), 1);
            });
            this.api.unregisterPlatformAccessories(Constants.PLUGIN_NAME, Constants.PLATFORM_NAME, accessoriesToRemove.map(accessory => accessory.getPlatformAccessory()));
        }
        return true;
    }

    async addAccessory(deviceInfo: Device) {
        const deviceType = <DeviceType> deviceInfo.dvcTypeCd;
        const uuid = this.api.hap.uuid.generate(deviceInfo.barcode);
        if(!this.accessories.find(accessory => accessory.getPlatformAccessory().UUID === uuid)) {
            this.log.info("Adding new accessory: %s (%s)", deviceInfo.dvcNick, deviceInfo.prodName);
            const platformAccessory = new this.api.platformAccessory(deviceInfo.dvcNick, uuid);
            const accessoryTypeString = deviceType + "+" + deviceInfo.prodName
            const accessoryType = this.accessoryRegistry[<SpecificDeviceType>accessoryTypeString];
            const accessory = new accessoryType(this.log, this.api, deviceInfo, this.service, platformAccessory);

            this.accessories.push(accessory);

            accessory.configureCredentials(this.config!, this.accessToken!);
            await accessory.configure();

            platformAccessory.context.configured = true;

            this.api.registerPlatformAccessories(Constants.PLUGIN_NAME, Constants.PLATFORM_NAME, [ platformAccessory ]);
            this.api.updatePlatformAccessories([platformAccessory]);
        } else {
            this.log.info("Restoring existing accessory: %s (%s)", deviceInfo.dvcNick, deviceInfo.prodName);
            for (const accessory of this.accessories.filter(accessory => accessory.getPlatformAccessory().UUID === uuid)) {
                accessory.configureCredentials(this.config!, this.accessToken!);
                accessory.setDeviceInfo(deviceInfo);
                await accessory.configure();

                const platformAccessory = accessory.getPlatformAccessory();
                platformAccessory.context.init = false;
                platformAccessory.context.deviceInfo = deviceInfo;
                platformAccessory.context.deviceType = deviceType;
                platformAccessory.context.configured = true;

                this.api.updatePlatformAccessories([platformAccessory]);
            }
        }
    }
}