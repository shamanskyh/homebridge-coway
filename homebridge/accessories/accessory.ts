import {
    API,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    HAPStatus,
    Logging,
    PlatformAccessory,
    Service,
    WithUUID
} from "homebridge";
import {CowayConfig} from "../interfaces/config";
import {AccessToken, CowayService, PayloadCommand} from "../coway";
import {DeviceType, EndpointPath, Field} from "../enumerations";
import {Device} from "../interfaces/device";
import {DeviceControlInfoRequest, IoCarePayloadRequest,} from "../interfaces/requests";

export type ServiceType = WithUUID<typeof Service>;
export type AccessoryResponses = { [key in EndpointPath]?: any }

export interface AccessoryInterface {
    deviceType: string;
    deviceInfo: Device;
    init: boolean;
    configured: boolean;
}

interface ExpirablePayloadCommand extends PayloadCommand {
    skips: number;
}

const COMMAND_MAXIMUM_SKIPS = 3;

export type CharacteristicRefreshingCallback = () => void | Promise<void>;
export type CharacteristicGetListener = (callback: CharacteristicGetCallback) => void;
export type CharacteristicSetListener = (value: CharacteristicValue, callback: CharacteristicSetCallback) => void;

export class Accessory<T extends AccessoryInterface> {

    protected readonly endpoints: EndpointPath[] = [];

    // Lazy-inits
    protected config?: CowayConfig = undefined;
    protected accessToken?: AccessToken = undefined;

    protected characteristicRefreshing = false;
    protected isConnected = false;

    constructor(protected readonly log: Logging,
                protected readonly api: API,
                protected readonly deviceType: DeviceType,
                protected deviceInfo: Device,
                protected readonly service: CowayService,
                protected readonly platformAccessory: PlatformAccessory) {
    }

    getEndpoints(): EndpointPath[] {
        return this.endpoints;
    }

    configureCredentials(config: CowayConfig, accessToken: AccessToken) {
        this.config = config;
        this.accessToken = accessToken;
    }

    getPlatformAccessory(): PlatformAccessory {
        return this.platformAccessory;
    }

    getDeviceId(): string {
        return this.deviceInfo.barcode;
    }

    setDeviceInfo(deviceInfo: Device) {
        this.deviceInfo = deviceInfo;
    }

    protected replace(context: T) {
        this.platformAccessory.context = context;
    }

    protected ensureServiceAvailability(serviceType: ServiceType, displayName?: string, serviceId?: string): Service {
        let service;
        if(displayName && serviceId) {
            service = this.platformAccessory.getServiceById(serviceType, serviceId);
        } else {
            service = this.platformAccessory.getService(serviceType);
        }
        if(!service) {
            displayName = displayName || this.platformAccessory.displayName;
            if(serviceId) {
                service = this.platformAccessory.addService(serviceType, displayName, serviceId);
            } else {
                service = this.platformAccessory.addService(serviceType, displayName);
            }
        }
        return service;
    }

    private createControlPayload(): DeviceControlInfoRequest {
        return {
            devId: this.deviceInfo.barcode,
            mqttDevice: "true",
            dvcBrandCd: this.deviceInfo.dvcBrandCd,
            dvcTypeCd: this.deviceInfo.dvcTypeCd,
            prodName: this.deviceInfo.prodName,
        };
    }

    createPayload(endpoint: EndpointPath): IoCarePayloadRequest | undefined {
        switch (endpoint) {
            case EndpointPath.DEVICES_CONTROL:
                return this.createControlPayload();
            default:
                return undefined;
        }
    }

    async retrieveDeviceState(endpoint: EndpointPath) {
        const path = endpoint.replace("{deviceId}", this.getDeviceId());
        const payload = this.createPayload(endpoint);
        if(!payload) {
            return undefined;
        }
        return await this.service.executeIoCareGetPayload(path, payload, this.accessToken);
    }

    zipEndpointResponses(responses: any[]) {
        if(responses.length != this.endpoints.length) {
            throw "Length between responses and endpoints must be same (" + responses.length + " != " + this.endpoints.length + ")";
        }
        const map: AccessoryResponses = {};
        for(let i = 0; i < responses.length; i++) {
            map[this.endpoints[i]] = responses[i].data;
        }
        return map;
    }

    async refreshDevice() {
        const queues = this.endpoints.map(endpoint => this.retrieveDeviceState(endpoint));
        const responses = await Promise.all(queues);
        return this.zipEndpointResponses(responses);
    }

    async refresh(responses: AccessoryResponses) {
        if(EndpointPath.DEVICES_CONTROL in responses) {
            const controlInfo: any | undefined = responses[EndpointPath.DEVICES_CONTROL];
            if(!controlInfo) {
                this.isConnected = false;
                return;
            }
            // Update device network connection info
            this.isConnected = controlInfo["netStatus"] as boolean;
        }
    }

    async refreshCharacteristics(callback: CharacteristicRefreshingCallback) {
        this.characteristicRefreshing = true;
        if(this.isConnected) {
            await callback();
        }
        this.characteristicRefreshing = false;
    }

    async configure() {
        const service = this.ensureServiceAvailability(this.api.hap.Service.AccessoryInformation);
        service.setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Coway Co.,Ltd.");
        service.setCharacteristic(this.api.hap.Characteristic.Model, this.deviceInfo.dvcModel);
        service.setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.deviceInfo.barcode);
    }

    async executeSetPayloads(deviceInfo: Device, inputs: PayloadCommand[], accessToken?: AccessToken) {
        if(!this.isConnected) {
            return;
        }
        return await this.service.executeSetPayloads(deviceInfo, inputs, accessToken);
    }

    async executeSetPayload(deviceInfo: Device, field: Field, value: string, accessToken?: AccessToken) {
        return await this.executeSetPayloads(deviceInfo, [{
            key: field,
            value: value
        }], accessToken);
    }

    wrapGet(listener: CharacteristicGetListener): CharacteristicGetListener {
        return (callback: CharacteristicGetCallback) => {
            if(!this.isConnected) {
                callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                return;
            }
            listener(callback);
        };
    }

    wrapSet(listener: CharacteristicSetListener): CharacteristicSetListener {
        return (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if(!this.isConnected) {
                callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                return;
            }
            listener(value, callback);
        };
    }
}
