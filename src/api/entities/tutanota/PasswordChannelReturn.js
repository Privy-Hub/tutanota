// @flow

import {create, TypeRef} from "../../common/EntityFunctions"

import type {PasswordChannelPhoneNumber} from "./PasswordChannelPhoneNumber"

export const PasswordChannelReturnTypeRef: TypeRef<PasswordChannelReturn> = new TypeRef("tutanota", "PasswordChannelReturn")
export const _TypeModel: TypeModel = {
	"name": "PasswordChannelReturn",
	"since": 1,
	"type": "DATA_TRANSFER_TYPE",
	"id": 327,
	"rootId": "CHR1dGFub3RhAAFH",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_format": {
			"name": "_format",
			"id": 328,
			"since": 1,
			"type": "Number",
			"cardinality": "One",
			"final": false,
			"encrypted": false
		}
	},
	"associations": {
		"phoneNumberChannels": {
			"name": "phoneNumberChannels",
			"id": 329,
			"since": 1,
			"type": "AGGREGATION",
			"cardinality": "Any",
			"refType": "PasswordChannelPhoneNumber",
			"final": true
		}
	},
	"app": "tutanota",
	"version": "41"
}

export function createPasswordChannelReturn(values?: $Shape<$Exact<PasswordChannelReturn>>): PasswordChannelReturn {
	return Object.assign(create(_TypeModel, PasswordChannelReturnTypeRef), values)
}

export type PasswordChannelReturn = {
	_type: TypeRef<PasswordChannelReturn>;

	_format: NumberString;

	phoneNumberChannels: PasswordChannelPhoneNumber[];
}