import {Accessory, AccessoryResponses} from "../accessory";
import {
    API,
    Characteristic,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Formats,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {Device} from "../../interfaces/device";
import {CowayService, PayloadCommand} from "../../coway";
import {AirmegaFanSpeed, Field, AirmegaLight, AirmegaMode, Power} from "./enumerations";
import {DeviceType, EndpointPath, AirmegaFilterCode} from "../../enumerations";
import {AirmegaControlInfo, FilterInfo, AirmegaAirPurifierInterface, AirmegaIndoorAirQuality} from "./interfaces";
import {IoCarePayloadRequest} from "../../interfaces/requests";

const ROTATION_SPEED_UNIT = 100 / 3.0;

// AIRMEGA Air Purifier
export class AirmegaAirPurifier extends Accessory<AirmegaAirPurifierInterface> {

    private airPurifierService?: Service;
    private airQualityService?: Service;
    private lightbulbService?: Service;
    private preFilterService?: Service;
    private maxFilterService?: Service;

    constructor(log: Logging, api: API, deviceInfo: Device, service: CowayService, platformAccessory: PlatformAccessory) {
        super(log, api, DeviceType.AIR_PURIFIER, deviceInfo, service, platformAccessory);
        this.endpoints.push(EndpointPath.DEVICES_CONTROL);
        this.endpoints.push(EndpointPath.AIR_DEVICES_HOME);
        this.endpoints.push(EndpointPath.AIR_DEVICES_FILTER_INFO);
    }

    async refresh(responses: AccessoryResponses): Promise<void> {
        await super.refresh(responses);

        if(!this.isConnected) {
            this.log.debug('Cannot refresh the accessory: %s', this.getPlatformAccessory().displayName);
            this.log.debug('The accessory response:', responses);
            return;
        }
        const filterInfo = responses[EndpointPath.AIR_DEVICES_FILTER_INFO];
        const statusInfo = responses[EndpointPath.AIR_DEVICES_HOME];
        const controlInfo = responses[EndpointPath.DEVICES_CONTROL];

        const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
        ctx.filterInfos = this.getFilterInfos(filterInfo);
        ctx.indoorAirQuality = this.getIndoorAirQuality(statusInfo);
        ctx.controlInfo = this.getControlInfo(controlInfo);

        await this.refreshCharacteristics(() => {
            // Air Purifiers
            this.airPurifierService?.setCharacteristic(this.api.hap.Characteristic.Active, ctx.controlInfo.on);
            this.airPurifierService?.setCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, this.getCurrentAirPurifierState(ctx));
            this.airPurifierService?.setCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, this.getPurifierDrivingStrategy(ctx));
            this.airPurifierService?.setCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.getRotationSpeedPercentage(ctx));

            // Lightbulbs
            this.lightbulbService?.setCharacteristic(this.api.hap.Characteristic.On, ctx.controlInfo.on && ctx.controlInfo.lightbulb);

            // Air Quality
            this.airQualityService?.setCharacteristic(this.api.hap.Characteristic.AirQuality, this.getCurrentAirQuality(ctx));
            this.airQualityService?.setCharacteristic(this.api.hap.Characteristic.PM10Density, ctx.indoorAirQuality.pm10Density);

            // filters
            this.preFilterService?.setCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, this.getCurrentFilterChangeIndication(ctx, AirmegaFilterCode.PRE_FILTER));
            this.preFilterService?.setCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, this.getCurrentFilterPercentage(ctx, AirmegaFilterCode.PRE_FILTER));
            this.maxFilterService?.setCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, this.getCurrentFilterChangeIndication(ctx, AirmegaFilterCode.MAX_FILTER));
            this.maxFilterService?.setCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, this.getCurrentFilterPercentage(ctx, AirmegaFilterCode.MAX_FILTER));
        });
    }

    createPayload(endpoint: EndpointPath): IoCarePayloadRequest | undefined {
        switch (endpoint) {
            case EndpointPath.AIR_DEVICES_HOME:
                return {
                    admdongCd: this.deviceInfo.admdongCd,
                    barcode: this.deviceInfo.barcode,
                    dvcBrandCd: this.deviceInfo.dvcBrandCd,
                    prodName: this.deviceInfo.prodName,
                    stationCd: this.deviceInfo.stationCd,
                    zipCode: "",
                    resetDttm: this.deviceInfo.resetDttm,
                    deviceType: this.deviceType,
                    mqttDevice: "true",
                    orderNo: this.deviceInfo.ordNo,
                    membershipYn: this.deviceInfo.membershipYn,
                    selfYn: this.deviceInfo.selfManageYn,
                };
            case EndpointPath.AIR_DEVICES_FILTER_INFO:
                return {
                    devId: this.deviceInfo.barcode,
                    orderNo: this.deviceInfo.ordNo,
                    sellTypeCd: this.deviceInfo.sellTypeCd,
                    prodName: this.deviceInfo.prodName,
                    membershipYn: this.deviceInfo.membershipYn,
                    mqttDevice: "true",
                    selfYn: this.deviceInfo.selfManageYn,
                };
            default:
                return super.createPayload(endpoint);
        }
    }

    async configure() {
        await super.configure();

        const responses = await this.refreshDevice();
        if(this.isConnected) {
            const statusInfo = responses[EndpointPath.AIR_DEVICES_HOME];
            const controlInfo = responses[EndpointPath.DEVICES_CONTROL];
            const filterInfo = responses[EndpointPath.AIR_DEVICES_FILTER_INFO];

            this.replace({
                deviceType: this.deviceType,
                deviceInfo: this.deviceInfo,
                init: false,
                configured: true,
                filterInfos: this.getFilterInfos(statusInfo),
                indoorAirQuality: this.getIndoorAirQuality(statusInfo),
                controlInfo: this.getControlInfo(controlInfo)
            });
        }

        this.airPurifierService = this.registerAirPurifierService();

        this.airQualityService = this.registerAirQualityService();
        this.lightbulbService = this.registerLightbulbService();
        this.preFilterService = this.registerFilterMaintenanceService(AirmegaFilterCode.PRE_FILTER);
        this.maxFilterService = this.registerFilterMaintenanceService(AirmegaFilterCode.MAX_FILTER);
    }

    getControlInfo(controlInfo: any): AirmegaControlInfo {
        const status = controlInfo["controlStatus"];
        return {
            on: status[Field.POWER] === Power.ON, // 1 → ON, 0 → OFF
            lightbulb: status[Field.LIGHT] === AirmegaLight.ON, // 2 → ON, 0 → OFF
            fanSpeed: status[Field.FAN_SPEED] as AirmegaFanSpeed,
            mode: status[Field.MODE] == "1" ? AirmegaMode.AUTO : AirmegaMode.MANUAL,
        };
    }

    getIndoorAirQuality(statusInfo: any): AirmegaIndoorAirQuality {
        const response = statusInfo["IAQ"];
        return {
            pm10Density: parseFloat(response["dustpm10"])
        };
    }

    getFilterInfos(filterInfo: any): FilterInfo[] {
        const filters = filterInfo["filterList"] as any[];
        return filters.map(filter => {
            return {
                filterName: filter["filterName"],
                filterCode: filter["filterCode"],
                filterPercentage: filter["filterPer"]
            };
        });
    }

    registerLightbulbService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.Lightbulb, this.platformAccessory.displayName + " Light");
        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, ctx.controlInfo.on && ctx.controlInfo.lightbulb);
            }))
            .on(CharacteristicEventTypes.SET, this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                if (value && ctx.controlInfo.lightbulb || !value && !ctx.controlInfo.lightbulb) {
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }
                if (!ctx.controlInfo.on) {
                    // if the purifier isn't on, just throw the lightbulb switch back off if we try to adjust it
                    ctx.controlInfo.lightbulb = false;
                    service.getCharacteristic(this.api.hap.Characteristic.On).updateValue(false)
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }
                await this.executeSetPayload(this.deviceInfo, Field.LIGHT, value ? AirmegaLight.ON : AirmegaLight.OFF, this.accessToken);
                ctx.controlInfo.lightbulb = value ? true : false;
                service.getCharacteristic(this.api.hap.Characteristic.On).updateValue(value);
                callback(this.api.hap.HAPStatus.SUCCESS);
            }));

        return service;
    }

    registerAirPurifierService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.AirPurifier, this.platformAccessory.displayName + " Purifier");
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, ctx.controlInfo.on ? this.api.hap.Characteristic.Active.ACTIVE : this.api.hap.Characteristic.Active.INACTIVE);
            }))
            .on(CharacteristicEventTypes.SET, this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                if (value == this.api.hap.Characteristic.Active.ACTIVE && ctx.controlInfo.on || value == this.api.hap.Characteristic.Active.INACTIVE && !ctx.controlInfo.on) {
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }
                await this.executeSetPayload(this.deviceInfo, Field.POWER, value ? Power.ON : Power.OFF, this.accessToken);
                ctx.controlInfo.on = (value == this.api.hap.Characteristic.Active.ACTIVE) ? true : false;
                service.getCharacteristic(this.api.hap.Characteristic.Active).updateValue(value);
                service.getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState).updateValue((value == this.api.hap.Characteristic.Active.ACTIVE) ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
                
                if (!value) {
                    // if the purifier turns off, the lightbulb also goes off
                    ctx.controlInfo.lightbulb = false;
                    this.lightbulbService?.getCharacteristic(this.api.hap.Characteristic.On).updateValue(false);
                }
                callback(this.api.hap.HAPStatus.SUCCESS);
            }));

        service.getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentAirPurifierState(ctx));
            }));

        service.getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getPurifierDrivingStrategy(ctx));
            }))
            .on(CharacteristicEventTypes.SET, this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                const wasAuto = ctx.controlInfo.mode === AirmegaMode.AUTO;
                const isAuto = value === this.api.hap.Characteristic.TargetAirPurifierState.AUTO;
                if(wasAuto === isAuto) {
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }

                if(isAuto) {
                    await this.driveAutomatically(ctx);
                    ctx.controlInfo.mode = AirmegaMode.AUTO;
                } else {
                    await this.driveManually(ctx);
                    ctx.controlInfo.mode = AirmegaMode.MANUAL;
                }
                service.getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState).updateValue(value);
                callback(this.api.hap.HAPStatus.SUCCESS);
            }));

        service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: Formats.FLOAT,
                minValue: 0,
                maxValue: 100, // Up to level 3
                minStep: ROTATION_SPEED_UNIT
            })
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getRotationSpeedPercentage(ctx));
            }))
            .on(CharacteristicEventTypes.SET, this.wrapSet(async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                const oldRotationSpeed = this.getRotationSpeed(ctx);
                const newRotationSpeed = parseInt(((value as number) / ROTATION_SPEED_UNIT).toFixed(0));
                if(oldRotationSpeed === newRotationSpeed) {
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }
                const commands: PayloadCommand[] = [];
                // If the air purifier is offline, make sure wake them up
                if(!ctx.controlInfo.on) {
                    commands.push({
                        key: Field.POWER,
                        value: Power.ON
                    });
                    ctx.controlInfo.on = true;
                } else if(newRotationSpeed === 0) {
                    service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed).updateValue(newRotationSpeed);
                    callback(this.api.hap.HAPStatus.SUCCESS);
                    return;
                }
                
                commands.push({
                    key: Field.FAN_SPEED,
                    value: newRotationSpeed.toString()
                });
                switch (newRotationSpeed) {
                    case 1: ctx.controlInfo.fanSpeed = AirmegaFanSpeed.LOW;
                    case 2: ctx.controlInfo.fanSpeed = AirmegaFanSpeed.MEDIUM;
                    case 3: ctx.controlInfo.fanSpeed = AirmegaFanSpeed.HIGH;
                }

                await this.executeSetPayloads(this.deviceInfo, commands, this.accessToken);
                service.getCharacteristic(this.api.hap.Characteristic.RotationSpeed).updateValue(this.getRotationSpeedPercentage(ctx));
                callback(this.api.hap.HAPStatus.SUCCESS);
            }));
        return service;
    }

    async driveAutomatically(ctx: AirmegaAirPurifierInterface) {
        ctx.controlInfo.mode = AirmegaMode.AUTO;
        await this.executeSetPayload(this.deviceInfo, Field.MODE, AirmegaMode.AUTO, this.accessToken);
    }

    async driveManually(ctx: AirmegaAirPurifierInterface) {
        // Find out same output speed during auto-driving mode
        const rotationSpeed = this.getRotationSpeed(ctx);
        ctx.controlInfo.mode = AirmegaMode.MANUAL;
        await this.executeSetPayload(this.deviceInfo, Field.FAN_SPEED, rotationSpeed.toString(), this.accessToken); 
    }

    registerAirQualityService(): Service {
        const service = this.ensureServiceAvailability(this.api.hap.Service.AirQualitySensor, this.platformAccessory.displayName + " Air Quality Sensor");
        service.getCharacteristic(this.api.hap.Characteristic.AirQuality)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentAirQuality(ctx));
            }));
        service.getCharacteristic(this.api.hap.Characteristic.PM10Density)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                const airQuality = ctx.indoorAirQuality;
                callback(this.api.hap.HAPStatus.SUCCESS, airQuality.pm10Density);
            }));
        return service;
    }

    registerFilterMaintenanceService(filterCode: AirmegaFilterCode): Service {
        // Fix the display name
        let englishName;
        if (filterCode == AirmegaFilterCode.PRE_FILTER) {
            englishName = "Pre Filter";
        } else if (filterCode == AirmegaFilterCode.MAX_FILTER) {
            englishName = "Max Filter";
        } else {
            englishName = "Unknown Filter";
        }
        const service = this.ensureServiceAvailability(this.api.hap.Service.FilterMaintenance, englishName, filterCode);
        service.getCharacteristic(this.api.hap.Characteristic.FilterChangeIndication)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                // Filter Change Indication GET
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentFilterChangeIndication(ctx, filterCode));
            }));
        service.getCharacteristic(this.api.hap.Characteristic.FilterLifeLevel)
            .on(CharacteristicEventTypes.GET, this.wrapGet((callback: CharacteristicGetCallback) => {
                // Filter Life Level GET
                const ctx = this.platformAccessory.context as AirmegaAirPurifierInterface;
                callback(this.api.hap.HAPStatus.SUCCESS, this.getCurrentFilterPercentage(ctx, filterCode));
            }));
        return service;
    }

    getPurifierDrivingStrategy(ctx: AirmegaAirPurifierInterface): CharacteristicValue {
        if(ctx.controlInfo.mode == AirmegaMode.AUTO) {
            return this.api.hap.Characteristic.TargetAirPurifierState.AUTO;
        } else {
            return this.api.hap.Characteristic.TargetAirPurifierState.MANUAL;
        }
    }

    getCurrentAirPurifierState(ctx: AirmegaAirPurifierInterface): CharacteristicValue {
        if(!ctx.controlInfo.on) {
            return this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE;
        }
        return this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    }

    getCurrentAirQuality(ctx: AirmegaAirPurifierInterface) {
        const pm10 = ctx.indoorAirQuality.pm10Density;
        if(!ctx.controlInfo.on) {
            return this.api.hap.Characteristic.AirQuality.UNKNOWN;
        }

        // PM10 Air Quality
        let pm10Level;
        if(pm10 < 0) {
            pm10Level = this.api.hap.Characteristic.AirQuality.UNKNOWN;
        } else if(pm10 <= 10) {
            pm10Level = this.api.hap.Characteristic.AirQuality.EXCELLENT;
        } else if(pm10 <= 30) {
            pm10Level = this.api.hap.Characteristic.AirQuality.GOOD;
        } else if(pm10 <= 80) {
            pm10Level = this.api.hap.Characteristic.AirQuality.FAIR;
        } else if(pm10 <= 150) {
            pm10Level = this.api.hap.Characteristic.AirQuality.INFERIOR;
        } else {
            pm10Level = this.api.hap.Characteristic.AirQuality.POOR;
        }
        return pm10Level as CharacteristicValue;
    }

    getCurrentFilterChangeIndication(ctx: AirmegaAirPurifierInterface, filterCode: AirmegaFilterCode) {
        const filter = ctx.filterInfos.find(filter => filter.filterCode === filterCode);
        const percentage = filter?.filterPercentage ?? 100;
        if (percentage <= 20) {
            return this.api.hap.Characteristic.FilterChangeIndication.CHANGE_FILTER;
        } else {
            return this.api.hap.Characteristic.FilterChangeIndication.FILTER_OK;
        }
    }

    getCurrentFilterPercentage(ctx: AirmegaAirPurifierInterface, filterCode: AirmegaFilterCode) {
        const filter = ctx.filterInfos.find(filter => filter.filterCode === filterCode);
        return (filter?.filterPercentage ?? 100) as CharacteristicValue;
    }

    getRotationSpeed(ctx: AirmegaAirPurifierInterface) {
        if(!ctx.controlInfo.on) {
            return 0;
        }
        return parseInt(ctx.controlInfo.fanSpeed);
    }

    getRotationSpeedPercentage(ctx: AirmegaAirPurifierInterface): number {
        return this.getRotationSpeed(ctx) * ROTATION_SPEED_UNIT; // float32
    }
}