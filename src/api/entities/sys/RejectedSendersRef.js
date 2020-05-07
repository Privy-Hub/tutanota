// @flow

import {create, TypeRef} from "../../common/EntityFunctions"


export const RejectedSendersRefTypeRef: TypeRef<RejectedSendersRef> = new TypeRef("sys", "RejectedSendersRef")
export const _TypeModel: TypeModel = {
	"name": "RejectedSendersRef",
	"since": 60,
	"type": "AGGREGATED_TYPE",
	"id": 1746,
	"rootId": "A3N5cwAG0g",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_id": {
			"name": "_id",
			"id": 1747,
			"since": 60,
			"type": "CustomId",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		}
	},
	"associations": {
		"items": {
			"name": "items",
			"id": 1748,
			"since": 60,
			"type": "LIST_ASSOCIATION",
			"cardinality": "One",
			"refType": "RejectedSender",
			"final": true,
			"external": false
		}
	},
	"app": "sys",
	"version": "60"
}

export function createRejectedSendersRef(values?: $Shape<$Exact<RejectedSendersRef>>): RejectedSendersRef {
	return Object.assign(create(_TypeModel, RejectedSendersRefTypeRef), values)
}

export type RejectedSendersRef = {
	_type: TypeRef<RejectedSendersRef>;

	_id: Id;

	items: Id;
}