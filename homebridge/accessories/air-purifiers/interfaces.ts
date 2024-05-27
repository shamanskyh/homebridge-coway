import {AccessoryInterface} from "../accessory";
import {FanSpeed, Mode, AirQuality, AirmegaFanSpeed, AirmegaMode} from "./enumerations";

export interface FilterInfo {
    filterName: string;
    filterCode: string;
    filterPercentage: number;
}

export interface IndoorAirQuality {
    humidity: number;
    pm25Density: number;
    pm10Density: number;
    vocDensity: number;
    temperature: number;
}

export interface AirmegaIndoorAirQuality {
    pm10Density: number;
}

export interface LightbulbControlInfo {
    on: boolean;
    brightness: number;
}

export interface ControlInfo {
    on: boolean;
    airQuality: AirQuality;
    lightbulbInfo: LightbulbControlInfo;
    mode: Mode;
    fanSpeed: FanSpeed;
}

export interface AirmegaControlInfo {
    on: boolean;
    lightbulb: boolean;
    fanSpeed: AirmegaFanSpeed;
    mode: AirmegaMode
}

export interface MarvelAirPurifierInterface extends AccessoryInterface {
    filterInfos: FilterInfo[];
    indoorAirQuality: IndoorAirQuality;
    controlInfo: ControlInfo;
}

export interface AirmegaAirPurifierInterface extends AccessoryInterface {
    filterInfos: FilterInfo[];
    indoorAirQuality: AirmegaIndoorAirQuality;
    controlInfo: AirmegaControlInfo;
}
