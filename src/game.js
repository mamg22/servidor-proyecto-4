import Chance from 'chance';

import { wait_for, clamp, world_to_grid, grid_to_world, transpose_array } from './utility';
import { Point } from './common';
import { Entity } from './entity';
import { generate_level } from './level';
import { sprites, audios } from './resources';
import { astar, Graph } from './libs/astar';

export class Game {
    static State = Object.freeze({
        cancel: -1,
        processing: 0,
        player_turn: 1,
        inspect: 2, 
    });

    constructor(seed) {
        let tmp_chance = new Chance();
        this.seed = seed || tmp_chance.natural();
        this.procedural_rng = new Chance(this.seed);

        this.player = new Entity(
            3, 3,
            "Jugador", "El jugador",
            true, sprites.player.standing, Entity.Type.player, 1);

        this.levels = [];
        for (let i = 0; i < 5; i++) {
            let level = generate_level(this.procedural_rng, i+1);
            this.levels.push(level);
            level.entities.push(this.player);
        }
        this.level = this.levels[0];

        this.state = Game.State.player_turn;
        this.scale = 1.0;
        this.start_time = null;
        this.turn = 1;
    }

    async render() {
        const entities_elt = document.querySelector("#entities");
        const entity_elements = entities_elt.children;
        const entity_ids = this.level.entities.map(function(entity){
            return entity.id;
        });
    
        for (const entity_element of Array.from(entity_elements)) {
            const entity_id = +entity_element.getAttribute("entity-id")
            if (! entity_ids.includes(entity_id)) {
                entity_element.remove()
            }
        }
    
        if (this.level.entities.indexOf(this.player) == -1) {
            this.level.entities.push(this.player);
        }
        
        let animations = [];
        for (const entity of this.level.entities) {
            const elem_id = "entity-" + entity.id;
            let elem = document.getElementById(elem_id);
            if (!elem) {
                elem = document.createElement("div");
                elem.id = elem_id
                elem.setAttribute('entity-id', entity.id)
                let elem_img = document.createElement("img");
                elem_img.src = entity.sprite;
                elem.append(elem_img);
                elem.style.zIndex = 25 - entity.type;
                entities_elt.append(elem);
            }
            let anim = elem.animate([
                {left: elem.style.left,
                top:  elem.style.top},
                {left: CSS.px(grid_to_world(entity.x)),
                 top:  CSS.px(grid_to_world(entity.y))}
                ],
                {
                    duration: 125
                }
            );
            animations.push(wait_for(anim, 'finish'));
            elem.style.left = CSS.px(grid_to_world(entity.x));
            elem.style.top = CSS.px(grid_to_world(entity.y));
            const facing = entity.facing;
            elem.style.setProperty('--flip', entity.facing)
        }
        await Promise.all(animations);
        const player_elem_id = "entity-" + this.player.id;
        const player_elem = document.getElementById(player_elem_id);
        player_elem.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "center"
        });
    }
    

    render_map() {
        const new_table = document.createElement("table");
        new_table.id = "map-table";
    
        for (let y = 0; y < this.level.map.grid.height; y++) {
            let current_row = document.createElement("tr");
    
            for (let x = 0; x < this.level.map.grid.width; x++) {
                let current_cell = document.createElement("td");
                let cell_contents = document.createElement("div");
    
                cell_contents.setAttribute("x", x);
                cell_contents.setAttribute("y", y);
                cell_contents.classList.add("map-cell");
    
                if (this.level.map.grid.get(x, y) == 0) {
                    cell_contents.classList.add("solid");
                }
    
                current_cell.appendChild(cell_contents);
                current_row.appendChild(current_cell);
            }
    
            new_table.appendChild(current_row)
        }
    
        const map_table = document.querySelector("#map-table");
        map_table.replaceWith(new_table);
    }

    switch_level(target_level) {
        const current_level_number = this.level.number;
    
        const new_level = this.levels.find(function (item) {
            return item.number == target_level;
        });
    
        let level_info = document.getElementsByClassName('floor-indicator-value');
    
        if (new_level) {
            this.level.set_last_pos(this.player.x, this.player.y);
            this.level = new_level;
            const new_pos = this.level.last_player_pos;
            if (new_pos) {
                this.player.x = new_pos.x;
                this.player.y = new_pos.y;
            }
            this.render_map();
            this.render();
            for (const indicator of level_info) {
                indicator.innerText = new_level.number; 
            }
            return true;
        }
        else {
            return false;
        }
    }

    handle_input(x, y) {
        let action_list = []
        switch (this.state) {
            case Game.State.processing:
                this.state = Game.State.cancel;
                // Cannot handle input while busy
                return;
            case Game.State.player_turn:
                if (Math.abs(this.player.x - x) > 1 || Math.abs(this.player.y - y) > 1) {
                    let graph = new Graph(transpose_array(this.level.get_collision_map().content), {
                        diagonal: true
                    });
                    let start = graph.grid[this.player.x][this.player.y];
                    let end = graph.grid[x][y];
                    let result = astar.search(graph, start, end, {
                        heuristic: astar.heuristics.diagonal,
                    });
                    for (let move of result) {
                        action_list.push({move: new Point(move.x, move.y)})
                    }
                    break;
                }
                if (! this.level.get_collision_at(x, y)) {
                    action_list.push({move: new Point(x, y)})
                    break;
                }
                let entities = this.level.get_entities(x, y);
                if (entities.length > 0) {
                    const target = entities[0];
                    if (target.solid) {
                        this.push_msg("Atacas: " + entities[0].name)
                    }
                    else {
                        this.push_msg("Recoges: " + entities[0].name)
                    }
                }
                break;
            case Game.State.inspect:
                this.process_inspect(x, y);
                break;
            default:
                break;
        }
        this.tick_turns(action_list);
    }

    async tick_turns(actions) {
        this.state = Game.State.processing;
        for (const action of actions) {
            if (this.state === Game.State.cancel) {
                break;
            }
            console.log(this.turn + " ",action);
            if (action.move) {
                const point = action.move;
                this.player.move(point.x, point.y)
            }
            let ch = Chance();
            for (const entity of this.level.entities) {
                if (entity.type != Entity.Type.player) {
                    entity.move_relative(
                        ch.integer({min: -1, max: 1}),
                        ch.integer({min: -1, max: 1}),
                    )
                }
            }
            await this.render();
            this.turn++;
        }
        this.state = Game.State.player_turn;
    }

    async process_inspect(x, y) {
        const dialog = document.getElementById('entityinfo-dialog');
    
        for (const entity of this.level.get_entities(x, y)) {
            dialog.showModal();
            await wait_for(dialog, 'close');
        }
        this.state = State.player_turn;
    }

    zoom(direction) {
        let base_delta = 0.05;
        if (this.scale < 0.50) {
            base_delta = 0.0125;
        }
        else if (this.scale < 0.75) {
            base_delta = 0.025;
        }
        const delta = base_delta * Math.sign(direction);
        this.set_zoom(this.scale + delta, true);
    }

    set_zoom(zoom, do_render=false) {
        const game_view = document.querySelector("#game-view");
        const zoom_delta = zoom - this.scale;
        this.scale = clamp(zoom, 0.2, 2);
        typedLocalStorage.setItem("game-scale", this.scale);
        game_view.scrollLeft *= 1 + zoom_delta;
        game_view.scrollTop *= 1 + zoom_delta;
        document.body.style.setProperty("--scale", this.scale, "important");
        if (do_render) {
            this.render();
        }
    }

    set_audio(category, mute) {
        if (! (category in audios)) {
            throw Error("Invalid audio category")
        }
    
        typedLocalStorage.setItem(`mute-${category}`, mute)
        
        const category_audios = audios[category];
        for (const name in category_audios) {
            const target = category_audios[name];
            if (mute) {
                target.volume = 0;
                if (category == 'bgm') {
                    target.pause();
                }
            }
            else {
                target.volume = target._volume
                if (category == 'bgm') {
                    target.play();
                }
            }
        }
    }

    push_msg(message, category='default') {
        const messages_elt = document.getElementById("messages");
    
        let message_elt = document.createElement("div");
        message_elt.innerText = message;
        message_elt.classList.add('message', category);
        messages_elt.append(message_elt);
        setTimeout(function(e) {
            let m_anim = message_elt.animate([
                { opacity: 1 },
                { opacity: 0 }
            ],
                { duration: 3000 }
            );
            m_anim.addEventListener('finish', function(e) {
                message_elt.remove()
            })
        }, 7000);
        
        while (messages_elt.children.length > 8) {
            messages_elt.children[0].remove()
        }
    }

    load_settings() {
        for (const category in audios) {
            const stored_mute = typedLocalStorage.getItem(`mute-${category}`)
            this.set_audio(category, stored_mute || false)
        }
        this.set_zoom(typedLocalStorage.getItem('game-scale') || 1.0);
    }

    build_scoredata() {
        let scoredata = {};
    
        scoredata.seed = this.seed;
        scoredata.version = VERSION;
        scoredata.time_ms = this.total_time;
        scoredata.score = this.score;
        scoredata.date = this.end_time.toISOString();
        scoredata.success = this.success;
        scoredata.details = {};
    
        scoredata.details.kills = this.kills;
    
        return scoredata;
    }

    async upload_score() {
        const scoredata = build_scoredata()
        const data_json = JSON.stringify(scoredata)
    
        const upload_result = await fetch(
            "/api/v1/score", 
            {
                method: "POST",
                body: data_json,
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
    
        if (!upload_result.ok) {
            console.log("Failed upload:", upload_result);
            return null;
        }
    
        const json = await upload_result.json();
        const result = json.result;
    
        // Return the newly generated id
        return result;
    }

    show_gameover() {
        const gameover_dialog = document.getElementById("gameover-dialog");
        const score_field = document.getElementById("gameover-score");
        const time_field = document.getElementById("gameover-time");
    
        score_field.innerText = this.score;
        time_field.innerText = format_ms(this.total_time);
    
        gameover_dialog.showModal();
    }

    finish_run() {
        const end_time = new Date();
        const total_playtime = end_time - this.start_time;
    
        this.end_time = end_time;
        this.total_time = total_playtime;
    }
}
globalThis.Game = Game;