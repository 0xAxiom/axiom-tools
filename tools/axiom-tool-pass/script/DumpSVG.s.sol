// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AxiomToolPassRenderer} from "../contracts/AxiomToolPassRenderer.sol";

/// @notice Quick sanity dump of on-chain SVG for a few tokenIds — used to
/// eyeball rendering parity against the off-chain JS reference. Run with:
///   forge script script/DumpSVG.s.sol -vvv
contract DumpSVG is Script {
    function run() external {
        AxiomToolPassRenderer r = new AxiomToolPassRenderer();
        uint256[5] memory ids = [uint256(1), 6, 42, 250, 999];
        for (uint256 i = 0; i < ids.length; i++) {
            string memory s = r.svg(ids[i]);
            console.log("---- tokenId %s ----", ids[i]);
            console.log(s);
        }
    }
}
